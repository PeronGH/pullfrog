import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import arg from "arg";
import { config } from "dotenv";
import type { AgentResult } from "./agents/shared.ts";
import { type Inputs, main } from "./main.ts";
import { defineFixture } from "./test/utils.ts";
import { log } from "./utils/cli.ts";
import { setupTestRepo } from "./utils/setup.ts";

/**
 * default play fixture for ad-hoc testing.
 * change this freely without affecting any tests.
 */
export const playFixture = defineFixture(
  {
    prompt: `What is 2 + 2? Reply with just the number.`,
    effort: "mini",
  },
  { localOnly: true }
);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// load action's .env file in case it exists for local dev
config();
// also load .env from repo root (for monorepo structure)
config({ path: join(__dirname, "..", ".env") });

export async function run(inputsOrPrompt: Inputs | string): Promise<AgentResult> {
  // create unique temp directory path in OS temp location for parallel execution
  // use a parent dir from mkdtemp, then clone into a 'repo' subdirectory
  const tempParent = await mkdtemp(join(tmpdir(), "pullfrog-play-"));
  const tempDir = join(tempParent, "repo");
  const originalCwd = process.cwd();

  try {
    setupTestRepo({ tempDir });
    process.chdir(tempDir);
    // set GITHUB_WORKSPACE to tempDir so main() doesn't try to chdir to the CI checkout path
    process.env.GITHUB_WORKSPACE = tempDir;

    // allow passing full Inputs object or just a prompt string
    const inputs: Inputs =
      typeof inputsOrPrompt === "string" ? { prompt: inputsOrPrompt } : inputsOrPrompt;

    // set INPUT_* env vars for @actions/core.getInput()
    for (const [key, value] of Object.entries(inputs)) {
      if (value !== undefined && value !== null) {
        process.env[`INPUT_${key.toUpperCase()}`] = String(value);
      }
    }

    const result = await main();

    process.chdir(originalCwd);

    if (result.success) {
      log.success("Action completed successfully");
      return { success: true, output: result.output || undefined, error: undefined };
    } else {
      log.error(`Action failed: ${result.error || "Unknown error"}`);
      return { success: false, error: result.error || undefined, output: undefined };
    }
  } catch (err) {
    const errorMessage = (err as Error).message;
    log.error(`Error: ${errorMessage}`);
    return { success: false, error: errorMessage, output: undefined };
  } finally {
    // cleanup temp directory
    process.chdir(originalCwd);
    rmSync(tempParent, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = arg({
    "--help": Boolean,
    "--raw": String,
    "--local": Boolean,
    "-h": "--help",
    "-l": "--local",
  });

  if (args["--help"]) {
    log.info(`
Usage: node play.ts [options]

Test the Pullfrog action with the inline playFixture.

Options:
  --raw [input]           Use raw string as prompt, or JSON object as full fixture
  --local, -l             Run locally (default: runs in Docker)
  -h, --help              Show this help message

Environment:
  PLAY_LOCAL=1            Same as --local

Examples:
  node play.ts                                              # Run inline playFixture
  node play.ts --raw "Hello world"                          # Use raw string as prompt
  node play.ts --raw '{"prompt":"Hello","timeout":"5s"}'    # Use JSON fixture
    `);
    process.exit(0);
  }

  // default: run in Docker (unless --local or PLAY_LOCAL=1 or already inside Docker)
  const isInsideDocker = existsSync("/.dockerenv");
  const useLocal = args["--local"] || process.env.PLAY_LOCAL === "1" || isInsideDocker;

  if (!useLocal) {
    log.info("» running in Docker container...");

    const passArgs = process.argv
      .slice(2)
      // shell-escape each argument to handle special characters in JSON payloads
      .map((arg) => `'${arg.replace(/'/g, "'\\''")}'`)
      .join(" ");
    const nodeCmd = `node play.ts ${passArgs}`;

    // pass all env vars to docker
    const envFlags = Object.entries(process.env).flatMap(([key, value]) =>
      value !== undefined ? ["-e", `${key}=${value}`] : []
    );

    // SSH for git - platform-specific handling
    const sshFlags: string[] = [];
    let sshSetupCmd = "";
    const plat = platform();
    const home = process.env.HOME;

    if (plat === "win32") {
      throw new Error(
        "Docker mode is not supported on native Windows. Use WSL2 or set PLAY_LOCAL=1."
      );
    } else if (plat === "darwin") {
      // macOS: Docker Desktop SSH agent forwarding
      if (home) {
        const knownHostsPath = join(home, ".ssh", "known_hosts");
        if (existsSync(knownHostsPath)) {
          sshFlags.push("-v", `${knownHostsPath}:/root/.ssh/known_hosts:ro`);
        }
      }
      sshFlags.push(
        "-v",
        "/run/host-services/ssh-auth.sock:/run/host-services/ssh-auth.sock",
        "-e",
        "SSH_AUTH_SOCK=/run/host-services/ssh-auth.sock"
      );
    } else {
      // Linux/WSL: copy .ssh files into container with correct permissions
      if (home) {
        const sshDir = join(home, ".ssh");
        if (existsSync(sshDir)) {
          sshFlags.push("-v", `${sshDir}:/tmp/.ssh-host:ro`);
          // copy ssh keys, add github.com to known_hosts, set GIT_SSH_COMMAND to use them
          sshSetupCmd =
            "mkdir -p /tmp/home/.ssh && cp /tmp/.ssh-host/id_* /tmp/home/.ssh/ 2>/dev/null; chmod 600 /tmp/home/.ssh/id_* 2>/dev/null; " +
            "ssh-keyscan -t ed25519,rsa github.com >> /tmp/home/.ssh/known_hosts 2>/dev/null; chmod 644 /tmp/home/.ssh/known_hosts; " +
            "export GIT_SSH_COMMAND='ssh -i /tmp/home/.ssh/id_rsa -o UserKnownHostsFile=/tmp/home/.ssh/known_hosts -o StrictHostKeyChecking=no'; ";
        }
      }
    }

    // always allocate a pseudo-TTY - Claude Code may require it
    const ttyFlags = ["-t"];

    // run as current user to avoid Claude CLI's root user restriction
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;

    // use agent-specific volume to avoid conflicts when running in parallel
    const agentOverride = process.env.AGENT_OVERRIDE ?? "default";
    const volumeName = `pullfrog-action-node-modules-${agentOverride}`;

    // initialize volume with correct ownership (runs as root briefly)
    spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${volumeName}:/app/action/node_modules`,
        "node:24",
        "chown",
        "-R",
        `${uid}:${gid}`,
        "/app/action/node_modules",
      ],
      { stdio: "ignore", cwd: __dirname }
    );

    const result = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        ...ttyFlags,
        "--user",
        `${uid}:${gid}`,
        "-v",
        `${__dirname}:/app/action:cached`,
        "-v",
        `${volumeName}:/app/action/node_modules`,
        "-w",
        "/app/action",
        ...envFlags,
        ...sshFlags,
        "-e",
        "COREPACK_ENABLE_DOWNLOAD_PROMPT=0",
        "-e",
        "HOME=/tmp/home",
        "-e",
        "TMPDIR=/tmp",
        "node:24",
        "bash",
        "-c",
        `${sshSetupCmd}mkdir -p /tmp/home/.config /tmp/home/.cache && corepack pnpm install --frozen-lockfile --ignore-scripts && ${nodeCmd}`,
      ],
      { stdio: "inherit", cwd: __dirname }
    );

    process.exit(result.status ?? 1);
  }

  if (args["--raw"]) {
    const raw = args["--raw"];
    // try to parse as JSON, otherwise treat as prompt string
    let input: Inputs | string = raw;
    try {
      input = JSON.parse(raw) as Inputs;
    } catch {
      // not valid JSON, use as prompt string
    }
    const result = await run(input);
    process.exit(result.success ? 0 : 1);
  }

  // no args - use inline playFixture
  const result = await run(playFixture);
  process.exit(result.success ? 0 : 1);
}

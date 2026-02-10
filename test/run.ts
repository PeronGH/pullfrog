import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { runInDocker } from "../utils/docker.ts";
import { acquireNewToken } from "../utils/github.ts";
import { isInsideDocker } from "../utils/globals.ts";
import {
  installSignalHandlers,
  killTrackedChildren,
  setSignalHandler,
} from "../utils/subprocess.ts";
import {
  agents,
  printResults,
  printSingleValidation,
  runAgentStreaming,
  type TestRunnerOptions,
  type TestTag,
  type ValidationResult,
  validateResult,
} from "./utils.ts";

/**
 * unified test runner for all agent tests.
 *
 * usage: node test/run.ts [filters...]
 *
 * filters can be test names, tags, or agent names:
 *   node test/run.ts               # run all tests (excludes adhoc-tagged tests)
 *   node test/run.ts smoke         # run tests named "smoke" or tagged "smoke"
 *   node test/run.ts claude        # run all tests for claude only
 *   node test/run.ts fs            # run all tests tagged "fs"
 *   node test/run.ts agnostic      # run all agnostic-tagged tests (with claude)
 *   node test/run.ts adhoc         # run all adhoc-tagged tests
 *   node test/run.ts smoke claude  # run smoke tests for claude only
 *
 * special tags:
 *   - "agnostic": runs with claude only, excluded when filtering by agent
 *   - "adhoc": excluded from default runs, must be explicitly requested
 *
 * by default, runs in a Docker container for isolation.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
export const actionDir = join(__dirname, "..");

// load .env files
config({ path: join(actionDir, ".env") });
config({ path: join(actionDir, "..", ".env") });

const nodeModulesVolume = "pullfrog-action-test-node-modules";
const mcpPortBase = 49000;
let nextMcpPort = mcpPortBase;

function allocateMcpPort(): number {
  const port = nextMcpPort;
  nextMcpPort += 1;
  return port;
}

function buildNodeCmd(args: string[]): string {
  const passArgs = args.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" ");
  return `node test/run.ts ${passArgs}`;
}

// run the test runner inside docker
function runTestsInDocker(args: string[]): never {
  const result = runInDocker({
    actionDir,
    args,
    nodeCmd: buildNodeCmd(args),
    volumeName: nodeModulesVolume,
    envFilterMode: "allowlist",
    onStart: () => console.log("» running tests in docker container...\n"),
  });

  process.exit(result.status ?? 1);
}

type TestInfo = {
  name: string;
  config: TestRunnerOptions;
};

type CancelState = {
  canceled: boolean;
  signal: NodeJS.Signals | null;
};

type TestModule = {
  test?: TestRunnerOptions;
  tests?: Record<string, TestRunnerOptions>;
};

// load all tests from all directories
async function loadAllTests(): Promise<TestInfo[]> {
  const testInfos: TestInfo[] = [];
  const dirs = ["crossagent", "agnostic", "adhoc"];

  for (const dir of dirs) {
    const dirPath = join(__dirname, dir);
    if (!existsSync(dirPath)) continue;

    const files = readdirSync(dirPath).filter((f) => f.endsWith(".ts"));
    for (const file of files) {
      const filePath = join(dirPath, file);
      const module = (await import(filePath)) as TestModule;

      if (module.test) {
        testInfos.push({ name: module.test.name, config: module.test });
      } else if (module.tests) {
        const entries = Object.entries(module.tests);
        for (const entry of entries) {
          testInfos.push({ name: entry[0], config: entry[1] });
        }
      }
    }
  }

  return testInfos;
}

// check if test has a specific tag
function hasTag(test: TestInfo, tag: TestTag): boolean {
  return test.config.tags?.includes(tag) ?? false;
}

type ParsedArgs = {
  filters: string[]; // test names or tags
  agentFilters: string[];
};

function parseArgs(args: string[], allTests: TestInfo[]): ParsedArgs {
  const testNames = new Set(allTests.map((t) => t.name));
  const allTags = new Set(allTests.flatMap((t) => t.config.tags ?? []));

  const filters: string[] = [];
  const agentFilters: string[] = [];

  for (const arg of args) {
    if (agents.includes(arg as (typeof agents)[number])) {
      agentFilters.push(arg);
    } else if (testNames.has(arg) || allTags.has(arg as TestTag)) {
      filters.push(arg);
    } else {
      console.error(`unknown argument: ${arg}`);
      console.error(`available tests: ${[...testNames].join(", ")}`);
      console.error(`available tags: ${[...allTags].join(", ")}`);
      console.error(`available agents: ${agents.join(", ")}`);
      process.exit(1);
    }
  }

  return { filters, agentFilters };
}

// filter tests based on filters (names or tags)
function filterTests(allTests: TestInfo[], filters: string[]): TestInfo[] {
  if (filters.length === 0) {
    // default: exclude adhoc tests
    return allTests.filter((t) => !hasTag(t, "adhoc"));
  }

  // match tests by name or tag
  return allTests.filter((t) => {
    for (const filter of filters) {
      if (t.name === filter || hasTag(t, filter as TestTag)) {
        return true;
      }
    }
    return false;
  });
}

type RunContext = {
  testInfo: TestInfo;
  agent: string;
  cancelState: CancelState;
  results: Map<string, ValidationResult>;
};

function getRunKey(test: string, agent: string): string {
  return `${test}::${agent}`;
}

type CanceledValidationContext = {
  testInfo: TestInfo;
  agent: string;
  signal: NodeJS.Signals;
};

function buildCanceledValidation(ctx: CanceledValidationContext): ValidationResult {
  return {
    test: ctx.testInfo.name,
    agent: ctx.agent,
    passed: false,
    canceled: true,
    checks: [{ name: "canceled", passed: false }],
    output: `canceled by ${ctx.signal}`,
  };
}

async function runTestForAgent(ctx: RunContext): Promise<ValidationResult> {
  const testConfig = ctx.testInfo.config;
  const env: Record<string, string> = {};
  if (testConfig.env) {
    const entries = Object.entries(testConfig.env);
    for (const entry of entries) {
      env[entry[0]] = entry[1];
    }
  }
  if (testConfig.agentEnv) {
    const agentEnv = testConfig.agentEnv.get(ctx.agent);
    if (agentEnv) {
      const entries = Object.entries(agentEnv);
      for (const entry of entries) {
        env[entry[0]] = entry[1];
      }
    }
  }

  if (!Object.hasOwn(env, "PULLFROG_MCP_PORT")) {
    env.PULLFROG_MCP_PORT = String(allocateMcpPort());
  }

  // pass repo setup commands to play.ts for pre-agent execution
  if (testConfig.repoSetup) {
    env.PULLFROG_TEST_REPO_SETUP = testConfig.repoSetup;
  }

  // opencode: set model override so tests use a model with quota (avoids default picking one without quota)
  if (ctx.agent === "opencode") {
    env.OPENCODE_MODEL = "google/gemini-3-flash-preview";
  }

  // build file-based env vars for MCP servers that don't inherit parent env
  let fileEnv: Record<string, string> | undefined;
  if (testConfig.fileAgentEnv) {
    const agentFileEnv = testConfig.fileAgentEnv.get(ctx.agent);
    if (agentFileEnv) {
      fileEnv = {};
      const entries = Object.entries(agentFileEnv);
      for (const entry of entries) {
        fileEnv[entry[0]] = entry[1];
      }
    }
  }

  const result = await runAgentStreaming({
    test: ctx.testInfo.name,
    agent: ctx.agent,
    fixture: testConfig.fixture,
    env,
    fileEnv,
    isCanceled: () => ctx.cancelState.canceled,
  });

  const validation = validateResult(result, testConfig.validator, {
    test: ctx.testInfo.name,
    expectFailure: testConfig.expectFailure,
  });
  ctx.results.set(getRunKey(ctx.testInfo.name, ctx.agent), validation);
  return validation;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // run in Docker unless already inside
  if (!isInsideDocker) {
    // acquire token for docker if needed
    if (!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) {
      if (process.env.GITHUB_APP_ID && process.env.GITHUB_PRIVATE_KEY) {
        console.log("» acquiring github installation token...");
        const token = await acquireNewToken();
        process.env.GITHUB_TOKEN = token;
      }
    }
    runTestsInDocker(args);
  }

  // load all tests
  const allTests = await loadAllTests();
  const parsed = parseArgs(args, allTests);

  // filter tests
  const filteredTests = filterTests(allTests, parsed.filters);

  if (filteredTests.length === 0) {
    console.error("no tests to run");
    process.exit(1);
  }

  // determine which agents to run
  const agentsToRun = parsed.agentFilters.length > 0 ? parsed.agentFilters : [...agents];

  // build list of test runs
  type TestRun = { testInfo: TestInfo; agent: string };
  const runs: TestRun[] = [];

  for (const testInfo of filteredTests) {
    const isAgnostic = hasTag(testInfo, "agnostic");

    if (isAgnostic) {
      // agnostic tests: skip if only filtering by agent, otherwise run with claude
      if (parsed.filters.length === 0 && parsed.agentFilters.length > 0) {
        continue;
      }
      runs.push({ testInfo, agent: "claude" });
    } else {
      // determine which agents to run for this test
      const testAgents = testInfo.config.agents ?? agents;
      const effectiveAgents = agentsToRun.filter((a) => testAgents.includes(a));
      for (const agent of effectiveAgents) {
        runs.push({ testInfo, agent });
      }
    }
  }

  if (runs.length === 0) {
    console.error("no test runs after filtering");
    process.exit(1);
  }

  // describe what we're running
  const runTestNames = [...new Set(runs.map((r) => r.testInfo.name))];
  const runAgentNames = [...new Set(runs.map((r) => r.agent))];
  console.log(`running ${runTestNames.join(", ")} for: ${runAgentNames.join(", ")}\n`);

  const cancelState: CancelState = { canceled: false, signal: null };
  const results = new Map<string, ValidationResult>();
  let resultsPrinted = false;

  function printAndExit(validations: ValidationResult[]): void {
    if (resultsPrinted) return;
    resultsPrinted = true;
    console.log();
    for (const v of validations) {
      printSingleValidation(v);
    }
    printResults(validations);
    const allPassed = validations.every((v) => v.passed);
    process.exit(allPassed ? 0 : 1);
  }

  function handleCancel(signal: NodeJS.Signals): void {
    if (cancelState.canceled) return;
    cancelState.canceled = true;
    cancelState.signal = signal;
    killTrackedChildren();

    const validations: ValidationResult[] = [];
    for (const run of runs) {
      const key = getRunKey(run.testInfo.name, run.agent);
      const existing = results.get(key);
      if (existing) {
        validations.push(existing);
      } else {
        validations.push(
          buildCanceledValidation({
            testInfo: run.testInfo,
            agent: run.agent,
            signal,
          })
        );
      }
    }
    printAndExit(validations);
  }

  setSignalHandler(handleCancel);
  installSignalHandlers();

  // run tests with limited concurrency to avoid overwhelming agent APIs
  const maxConcurrency = 5;
  const validations = await runWithConcurrencyLimit(runs, maxConcurrency, (run) =>
    runTestForAgent({
      testInfo: run.testInfo,
      agent: run.agent,
      cancelState,
      results,
    })
  );

  if (!cancelState.canceled) {
    printAndExit(validations);
  }
}

// simple concurrency limiter
async function runWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  const executing: Promise<void>[] = [];

  for (const item of items) {
    const p = fn(item).then(
      (result) => {
        results.push(result);
      },
      (err: unknown) => {
        console.error("runWithConcurrencyLimit: fn rejected unexpectedly", err);
        throw err;
      }
    );

    const e = p.then(() => {
      executing.splice(executing.indexOf(e), 1);
    });
    executing.push(e);

    if (executing.length >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

main();

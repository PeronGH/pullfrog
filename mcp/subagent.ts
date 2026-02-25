import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Effort } from "../external.ts";
import { ghPullfrogMcpName } from "../external.ts";
import { markActivity } from "../utils/activity.ts";
import type { ResolvedInstructions } from "../utils/instructions.ts";
import { withLogPrefix } from "../utils/log.ts";
import { type SubagentState, startSubagentMcpServer, type ToolContext } from "./server.ts";

type CreateSubagentParams = {
  ctx: ToolContext;
  mode: string;
  label: string;
};

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

export function createSubagentState(params: CreateSubagentParams): SubagentState {
  const id = randomUUID();
  const slug = slugify(params.label);
  const stdoutFilePath = join(params.ctx.tmpdir, `subagent-${slug || id}.log`);
  const state: SubagentState = {
    id,
    label: params.label,
    status: "running",
    mode: params.mode,
    stdoutFilePath,
    output: undefined,
    usage: undefined,
    startedAt: Date.now(),
    keepAliveInterval: undefined,
  };
  params.ctx.toolState.subagents.set(id, state);
  return state;
}

type CompleteSubagentParams = {
  ctx: ToolContext;
  subagent: SubagentState;
  success: boolean;
};

function completeSubagent(params: CompleteSubagentParams): void {
  params.subagent.status = params.success ? "completed" : "failed";
  if (params.subagent.keepAliveInterval) {
    clearInterval(params.subagent.keepAliveInterval);
    params.subagent.keepAliveInterval = undefined;
  }
  if (params.subagent.usage) {
    params.ctx.toolState.usageEntries.push(params.subagent.usage);
  }
}

export function hasRunningSubagents(ctx: ToolContext): boolean {
  for (const s of ctx.toolState.subagents.values()) {
    if (s.status === "running") return true;
  }
  return false;
}

const subagentSystemPreamble = `You are a focused subagent. Complete the task autonomously — no follow-up questions. Minimize token usage.

## Tools

Your tools are limited to:
- **File operations**: \`${ghPullfrogMcpName}/file_read\`, \`file_write\`, \`file_edit\`, \`file_delete\`, \`list_directory\`. Native file tools (Read, Write, StrReplace, etc.) are disabled — use the MCP versions.
- **Shell**: \`${ghPullfrogMcpName}/shell\` (if available). Use this for local git operations (\`git add\`, \`git commit\`, \`git diff\`, \`git log\`, \`git status\`), running tests, builds, and linters.
- **Read-only GitHub**: \`get_pull_request\`, \`get_issue\`, \`get_issue_comments\`, \`get_issue_events\`, \`get_review_comments\`, \`list_pull_request_reviews\`, \`get_check_suite_logs\`, \`get_commit_info\`.
- **Output**: \`${ghPullfrogMcpName}/upload_file\`, \`${ghPullfrogMcpName}/set_output\`.

## Output

When you finish, you MUST call \`${ghPullfrogMcpName}/set_output\` with your results. This is how your work gets back to the orchestrator — if you don't call it, your output is lost. Structure output as the instructions request. For research tasks, use well-organized markdown.`;

type BuildSubagentInstructionsParams = {
  ctx: ToolContext;
  label: string;
  instructions: string;
};

function buildResolvedContext(params: BuildSubagentInstructionsParams): string {
  let branch = "unknown";
  try {
    branch = execSync("git branch --show-current", { encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    // git not available
  }

  const lines = [
    `repo: ${params.ctx.repo.owner}/${params.ctx.repo.name}`,
    `branch: ${branch}`,
    `working_directory: ${process.cwd()}`,
    `subagent_label: ${params.label}`,
  ];

  return `[CONTEXT]\n${lines.join("\n")}`;
}

export function buildSubagentInstructions(
  params: BuildSubagentInstructionsParams
): ResolvedInstructions {
  const resolvedContext = buildResolvedContext(params);
  const full = `${resolvedContext}\n\n${subagentSystemPreamble}\n\n---\n\n${params.instructions}`;
  return {
    full,
    system: subagentSystemPreamble,
    user: params.instructions,
    eventInstructions: "",
    repo: "",
    event: "",
    runtime: "",
  };
}

type RunSubagentParams = {
  ctx: ToolContext;
  subagent: SubagentState;
  effort: Effort;
  instructions: string;
};

type RunSubagentResult = {
  success: boolean;
  error: string | undefined;
};

export async function runSubagent(params: RunSubagentParams): Promise<RunSubagentResult> {
  return withLogPrefix(`[${params.subagent.label}]`, async () => {
    params.subagent.keepAliveInterval = setInterval(markActivity, 30_000);
    const mcpServer = await startSubagentMcpServer({
      ctx: params.ctx,
      subagentId: params.subagent.id,
    });
    // each subagent gets its own tmpdir so parallel agents don't clobber config files
    const subagentTmpdir = join(params.ctx.tmpdir, params.subagent.id);
    mkdirSync(subagentTmpdir, { recursive: true });
    try {
      const subagentPayload = { ...params.ctx.payload, effort: params.effort };
      const subagentInstructions = buildSubagentInstructions({
        ctx: params.ctx,
        label: params.subagent.label,
        instructions: params.instructions,
      });
      const result = await params.ctx.agent.run({
        payload: subagentPayload,
        mcpServerUrl: mcpServer.url,
        tmpdir: subagentTmpdir,
        instructions: subagentInstructions,
      });
      params.subagent.usage = result.usage;
      writeFileSync(params.subagent.stdoutFilePath, result.output ?? "", "utf-8");
      completeSubagent({ ctx: params.ctx, subagent: params.subagent, success: result.success });
      return { success: result.success, error: result.error };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      try {
        writeFileSync(params.subagent.stdoutFilePath, "", "utf-8");
      } catch {
        // best-effort
      }
      completeSubagent({ ctx: params.ctx, subagent: params.subagent, success: false });
      return { success: false, error: errorMessage };
    } finally {
      await mcpServer.stop();
    }
  });
}

import { type } from "arktype";
import { Effort } from "../external.ts";
import type { Mode } from "../modes.ts";
import { markActivity } from "../utils/activity.ts";
import { log } from "../utils/cli.ts";
import { resolveSubagentInstructions } from "../utils/instructions.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

export const DelegateParams = type({
  mode: type.string.describe(
    "the name of the mode to delegate to (e.g., 'Build', 'Plan', 'Review', 'Fix', 'AddressReviews')"
  ),
  "effort?": Effort.describe(
    'effort level for the subagent: "mini" (fast), "auto" (default, highly capable), or "max" (maximum capability)'
  ),
  "instructions?": type.string.describe(
    "optional additional context or instructions for the subagent — use this to pass results from earlier delegations or narrow the subagent's focus"
  ),
});

// exported for unit testing
export function resolveMode(modes: Mode[], modeName: string): Mode | null {
  return modes.find((m) => m.name.toLowerCase() === modeName.toLowerCase()) ?? null;
}

// cap subagent output to avoid bloating the orchestrator's context window.
// the orchestrator needs enough to understand what happened, not the full NDJSON stream.
const MAX_OUTPUT_CHARS = 20_000;

// exported for unit testing
export function truncateOutput(output: string | undefined): string | undefined {
  if (!output || output.length <= MAX_OUTPUT_CHARS) return output;
  const truncated = output.slice(-MAX_OUTPUT_CHARS);
  return `[truncated — showing last ${MAX_OUTPUT_CHARS} chars]\n${truncated}`;
}

export function DelegateTool(ctx: ToolContext) {
  return tool({
    name: "delegate",
    description:
      "Delegate a task to a subagent with a specific mode and effort level. The subagent runs as a separate process with the mode's step-by-step instructions.",
    parameters: DelegateParams,
    execute: execute(async (params) => {
      // guard: prevent subagent recursion
      if (ctx.toolState.delegationActive) {
        return {
          error: "delegation is not available inside a delegated subagent",
        };
      }

      // resolve mode
      const selectedMode = resolveMode(ctx.modes, params.mode);
      if (!selectedMode) {
        const availableModes = ctx.modes.map((m) => m.name).join(", ");
        return {
          error: `mode "${params.mode}" not found. available modes: ${availableModes}`,
          availableModes: ctx.modes.map((m) => ({
            name: m.name,
            description: m.description,
          })),
        };
      }

      const effort = params.effort ?? "auto";

      // track state
      ctx.toolState.selectedMode = selectedMode.name;
      ctx.toolState.delegationActive = true;

      log.info(
        `» delegating to ${selectedMode.name} mode (effort=${effort})${params.instructions ? " with orchestrator instructions" : ""}`
      );

      // keep the process-level activity timeout alive while the subagent runs.
      // agent CLIs can have long silent thinking phases (>60s) with no stdout,
      // which would trigger the activity timeout. the overall run timeout (default 1h)
      // is the real safety net for stalled agents.
      const keepAliveInterval = setInterval(markActivity, 30_000);

      try {
        // build subagent payload with effort override
        const subagentPayload = { ...ctx.payload, effort };

        // build subagent instructions with mode prompt baked in
        const subagentInstructions = resolveSubagentInstructions({
          payload: subagentPayload,
          repo: ctx.repo,
          modes: ctx.modes,
          mode: selectedMode,
          orchestratorInstructions: params.instructions,
        });

        // spawn subagent — reuses same MCP server, same toolState
        const result = await ctx.agent.run({
          payload: subagentPayload,
          mcpServerUrl: ctx.mcpServerUrl,
          tmpdir: ctx.tmpdir,
          instructions: subagentInstructions,
        });

        log.info(`» delegation to ${selectedMode.name} completed (success=${result.success})`);

        return {
          success: result.success,
          mode: selectedMode.name,
          effort,
          output: truncateOutput(result.output),
          error: result.error,
        };
      } catch (err) {
        // normalize agent crashes into the same return shape as clean failures
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.error(`» delegation to ${selectedMode.name} crashed: ${errorMessage}`);
        return {
          success: false,
          mode: selectedMode.name,
          effort,
          error: errorMessage,
        };
      } finally {
        clearInterval(keepAliveInterval);
        // always release the lock so the orchestrator can delegate again
        ctx.toolState.delegationActive = false;
      }
    }),
  });
}

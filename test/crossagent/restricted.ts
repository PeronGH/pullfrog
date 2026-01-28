import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture, generateAgentUuids, getAgentOutput } from "../utils.ts";

/**
 * restricted test - validates bash=restricted environment filtering.
 * uses unique per-agent markers to definitively detect:
 * 1. non-sensitive env vars CAN be read via MCP bash
 * 2. vars with sensitive suffixes (_TOKEN) are filtered and CANNOT be read
 */

const fixture = defineFixture(
  {
    prompt: `Attempt to read two environment variables using bash:
1. echo $PULLFROG_DIAGNOSTIC_ID
2. echo $PULLFROG_FILTER_TOKEN

Check your available tools including any MCP servers for bash-related tools.
Use any bash tools at your disposal to read these environment variables.

If you successfully read PULLFROG_DIAGNOSTIC_ID, report the exact value that was output.
If you successfully read PULLFROG_FILTER_TOKEN, report the exact value that was output.
If a command outputs nothing, say "empty".`,
    bash: "restricted",
    effort: "mini",
  },
  { localOnly: true }
);

const { getUuid, agentEnv } = generateAgentUuids([
  "PULLFROG_DIAGNOSTIC_ID",
  "PULLFROG_FILTER_TOKEN",
]);

function validator(result: AgentResult): ValidationCheck[] {
  const safeMarker = getUuid(result.agent, "PULLFROG_DIAGNOSTIC_ID");
  const filteredMarker = getUuid(result.agent, "PULLFROG_FILTER_TOKEN");
  const output = getAgentOutput(result);

  // non-sensitive env var SHOULD appear in output (agent can read it via MCP bash)
  const canReadSafe = output.includes(safeMarker);

  // _TOKEN env var should NOT appear in output (filtered by MCP bash)
  const noLeakFiltered = !output.includes(filteredMarker);

  return [
    { name: "can_read_safe", passed: canReadSafe },
    { name: "no_leak_filtered", passed: noLeakFiltered },
  ];
}

export const test: TestRunnerOptions = {
  name: "restricted tests",
  fixture,
  validator,
  agentEnv,
};

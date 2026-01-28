import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture } from "../utils.ts";

/**
 * smoke test - validates agent can connect to API and call MCP tools.
 * verifies select_mode tool is called with correct params.
 */

const fixture = defineFixture(
  {
    prompt: `Call the select_mode tool with modeName "Build" and confirm you received the mode's prompt instructions.

Then say "SMOKE TEST PASSED".`,
    effort: "mini",
  },
  { localOnly: true }
);

function validator(result: AgentResult): ValidationCheck[] {
  // verify MCP tool was called with correct params:
  // → select_mode({"modeName":"Build"}) or → mcp__gh_pullfrog__select_mode({"modeName":"Build"})
  const toolCallValid = /→.*select_mode\s*\([^)]*"modeName"\s*:\s*"Build"/i.test(result.output);
  // verify agent confirmed success
  const confirmationFound = /SMOKE TEST PASSED/i.test(result.output);

  return [
    { name: "tool_call", passed: toolCallValid },
    { name: "confirm", passed: confirmationFound },
  ];
}

export const test: TestRunnerOptions = {
  name: "smoke tests",
  fixture,
  validator,
};

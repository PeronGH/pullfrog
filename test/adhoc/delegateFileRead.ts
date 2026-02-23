import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture, getAgentOutput, getStructuredOutput } from "../utils.ts";

/**
 * delegate-file-read — orchestrator delegates a subagent to read a real file
 * from the repository and return its content.
 *
 * tests the full delegation pipeline: mode selection → prompt crafting with MCP
 * tool references → subagent file read → result propagation back to orchestrator.
 *
 * unlike the basic delegate test (which just echoes a hardcoded string), this
 * requires the subagent to actually use MCP tools (file_read) to interact with
 * the repo and return derived data.
 */

const fixture = defineFixture(
  {
    prompt: `You are an orchestrator. Your task:

1. Select the Plan mode via select_mode.
2. Delegate to a subagent with mini effort. Craft instructions telling it to:
   - Use gh_pullfrog/file_read to read the file "README.md" from the repository root
   - Count the total number of lines in the file
   - Call gh_pullfrog/set_output with EXACTLY this format: "LINES=<number>" where <number> is the line count (e.g., "LINES=42")
   - Do NOT create any branches, commits, or PRs
3. After the delegation completes, call set_output with the subagent's result (the LINES=<number> string).

IMPORTANT: Your subagent prompt must include the exact MCP tool names (gh_pullfrog/file_read, gh_pullfrog/set_output).`,
    effort: "auto",
    timeout: "8m",
  },
  { localOnly: true }
);

function validator(result: AgentResult): ValidationCheck[] {
  const output = getStructuredOutput(result);
  const agentOutput = getAgentOutput(result);

  const setOutputCalled = output !== null;
  const linesMatch = output ? /LINES=(\d+)/i.exec(output) : null;
  const hasLineCount = linesMatch !== null && parseInt(linesMatch[1], 10) > 0;
  const delegationOccurred = /» delegating \d+ task/i.test(agentOutput);

  return [
    { name: "set_output", passed: setOutputCalled },
    { name: "line_count_reported", passed: hasLineCount },
    { name: "delegation_occurred", passed: delegationOccurred },
  ];
}

export const test: TestRunnerOptions = {
  name: "delegate-file-read",
  fixture,
  validator,
  env: { GITHUB_REPOSITORY: "pullfrog/test-repo" },
  tags: ["adhoc"],
};

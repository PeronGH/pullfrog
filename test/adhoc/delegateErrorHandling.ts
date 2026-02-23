import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture, getAgentOutput, getStructuredOutput } from "../utils.ts";

/**
 * delegate-error-handling — orchestrator delegates a task that will fail,
 * then must handle the failure gracefully and report it.
 *
 * the subagent is told to read a file that doesn't exist, which will cause
 * file_read to return an error. the orchestrator should detect the subagent
 * failure (via the delegate tool's return value) and report it clearly.
 *
 * tests error propagation through the delegation system and the orchestrator's
 * ability to reason about failure modes rather than blindly forwarding results.
 */

const fixture = defineFixture(
  {
    prompt: `You are an orchestrator. This test validates error handling.

1. Select Plan mode via select_mode.
2. Delegate to a subagent with mini effort. Subagent instructions:
   "Use gh_pullfrog/file_read to read the file 'this-file-does-not-exist-anywhere.xyz'. Report what you find by calling gh_pullfrog/set_output with the file content. If the file cannot be read, call gh_pullfrog/set_output with 'FILE_NOT_FOUND'."
3. After the delegation completes, examine the result. The subagent should have reported FILE_NOT_FOUND or an error.
4. Call set_output with EXACTLY: "ERROR_HANDLED=true,REASON=<brief description of what went wrong>"

If the delegation failed entirely (subagent crashed), still call set_output with "ERROR_HANDLED=true,REASON=delegation_failed".

The point of this test is that you handle the error gracefully and report it — not that you succeed at reading the file.`,
    effort: "auto",
    timeout: "8m",
  },
  { localOnly: true }
);

function validator(result: AgentResult): ValidationCheck[] {
  const output = getStructuredOutput(result);
  const agentOutput = getAgentOutput(result);

  const setOutputCalled = output !== null;
  const errorHandled = setOutputCalled && /ERROR_HANDLED=true/i.test(output ?? "");
  const hasReason = setOutputCalled && /REASON=\S+/i.test(output ?? "");
  const delegationOccurred = /» delegating \d+ task/i.test(agentOutput);

  return [
    { name: "set_output", passed: setOutputCalled },
    { name: "error_handled", passed: errorHandled },
    { name: "reason_provided", passed: hasReason },
    { name: "delegation_occurred", passed: delegationOccurred },
  ];
}

export const test: TestRunnerOptions = {
  name: "delegate-error-handling",
  fixture,
  validator,
  env: { GITHUB_REPOSITORY: "pullfrog/test-repo" },
  tags: ["adhoc"],
};

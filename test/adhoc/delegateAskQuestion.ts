import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture, getAgentOutput, getStructuredOutput } from "../utils.ts";

/**
 * delegate-ask-question — orchestrator uses ask_question to gather codebase
 * info, then uses that answer to craft a targeted delegation.
 *
 * tests the ask_question → delegate pipeline: information gathering first,
 * then action based on gathered context. this validates that the orchestrator
 * can chain ask_question and delegate as a two-step workflow.
 */

const fixture = defineFixture(
  {
    prompt: `You are an orchestrator. Your task has TWO steps:

STEP 1 — GATHER INFO:
Use gh_pullfrog/ask_question to ask: "What files are in the root directory of this repository? List them."

STEP 2 — DELEGATE WITH CONTEXT:
After receiving the answer, select Plan mode via select_mode, then delegate to a subagent with mini effort.
Your subagent instructions MUST include:
- The list of files you learned about from step 1
- Tell the subagent to call gh_pullfrog/set_output with EXACTLY this format: "FILES_FOUND=true,COUNT=<N>" where <N> is the number of files from the list you gave it
- Do NOT create any branches, commits, or PRs

After delegation completes, call set_output yourself with the subagent's result.

IMPORTANT: You MUST use ask_question BEFORE delegating. The subagent prompt must reference specific files from the ask_question answer.`,
    effort: "auto",
    timeout: "10m",
  },
  { localOnly: true }
);

function validator(result: AgentResult): ValidationCheck[] {
  const output = getStructuredOutput(result);
  const agentOutput = getAgentOutput(result);

  const setOutputCalled = output !== null;
  const hasFilesFound = setOutputCalled && /FILES_FOUND=true/i.test(output ?? "");
  const countMatch = output ? /COUNT=(\d+)/i.exec(output) : null;
  const hasFileCount = countMatch !== null && parseInt(countMatch[1], 10) > 0;
  const askQuestionUsed = /» ask_question "/i.test(agentOutput);
  const delegationOccurred = /» delegating \d+ task/i.test(agentOutput);

  return [
    { name: "set_output", passed: setOutputCalled },
    { name: "files_found", passed: hasFilesFound },
    { name: "file_count", passed: hasFileCount },
    { name: "ask_question_used", passed: askQuestionUsed },
    { name: "delegation_occurred", passed: delegationOccurred },
  ];
}

export const test: TestRunnerOptions = {
  name: "delegate-ask-question",
  fixture,
  validator,
  env: { GITHUB_REPOSITORY: "pullfrog/test-repo" },
  tags: ["adhoc"],
};

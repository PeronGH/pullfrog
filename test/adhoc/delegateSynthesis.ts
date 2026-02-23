import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture, getAgentOutput, getStructuredOutput } from "../utils.ts";

/**
 * delegate-synthesis — orchestrator delegates two research tasks to separate
 * subagents, then synthesizes their results into a combined answer.
 *
 * phase 1: subagent reads README.md and extracts the first line.
 * phase 2: subagent counts how many .md files exist via list_directory.
 * synthesis: orchestrator combines both pieces of info into the final output.
 *
 * this tests the orchestrator's ability to:
 * - run multiple sequential delegations
 * - pass specific, different instructions to each subagent
 * - extract and combine results from separate delegation phases
 * - produce a structured final output from heterogeneous subagent responses
 */

const fixture = defineFixture(
  {
    prompt: `You are an orchestrator. You must delegate TWO research tasks and SYNTHESIZE the results.

PHASE 1 — GET FIRST LINE:
Select Plan mode via select_mode, then delegate with mini effort.
Subagent instructions: "Use gh_pullfrog/file_read to read 'README.md'. Extract the FIRST LINE of the file. Call gh_pullfrog/set_output with just the first line of text (nothing else)."

PHASE 2 — COUNT FILES:
Select Plan mode again, then delegate with mini effort.
Subagent instructions: "Use gh_pullfrog/list_directory to list the root directory '.'. Count how many items are listed. Call gh_pullfrog/set_output with just the number (nothing else)."

SYNTHESIS:
After both phases complete, YOU (the orchestrator) must call set_output with EXACTLY:
"FIRST_LINE=<first line from phase 1>,FILE_COUNT=<number from phase 2>"

Both pieces must come from the respective subagent results. Do NOT read the files yourself.`,
    effort: "auto",
    timeout: "10m",
  },
  { localOnly: true }
);

function validator(result: AgentResult): ValidationCheck[] {
  const output = getStructuredOutput(result);
  const agentOutput = getAgentOutput(result);

  const setOutputCalled = output !== null;

  // should have two delegation calls
  const delegationMatches = agentOutput.match(/» delegating \d+ task/g);
  const twoDelegations = delegationMatches !== null && delegationMatches.length >= 2;

  // FIRST_LINE should be a non-empty string (the first line of README.md)
  const firstLineMatch = output ? /FIRST_LINE=([^,]+)/i.exec(output) : null;
  const hasFirstLine = firstLineMatch !== null && firstLineMatch[1].trim().length > 0;

  // FILE_COUNT should be a positive number
  const countMatch = output ? /FILE_COUNT=(\d+)/i.exec(output) : null;
  const hasFileCount = countMatch !== null && parseInt(countMatch[1], 10) > 0;

  return [
    { name: "set_output", passed: setOutputCalled },
    { name: "two_delegations", passed: twoDelegations },
    { name: "first_line_extracted", passed: hasFirstLine },
    { name: "file_count_extracted", passed: hasFileCount },
  ];
}

export const test: TestRunnerOptions = {
  name: "delegate-synthesis",
  fixture,
  validator,
  env: { GITHUB_REPOSITORY: "pullfrog/test-repo" },
  tags: ["adhoc"],
};

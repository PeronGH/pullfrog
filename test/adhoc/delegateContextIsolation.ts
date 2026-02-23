import { randomUUID } from "node:crypto";
import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture, getAgentOutput, getStructuredOutput } from "../utils.ts";

/**
 * delegate-context-isolation — verifies that the subagent's "clean room"
 * actually works: the orchestrator receives a secret marker in its prompt but
 * MUST NOT include it in the subagent's instructions.
 *
 * the subagent is told to report everything it knows about the task context.
 * the validator checks that the secret marker does NOT appear in the subagent's
 * reported context, proving it only sees what the orchestrator explicitly passes.
 *
 * this is a critical architectural property of the delegation system.
 */

const SECRET = randomUUID();

const fixture = defineFixture(
  {
    prompt: `You are an orchestrator. READ CAREFULLY.

Your SECRET value is: ${SECRET}
You MUST remember this secret and include it in your OWN final set_output call.
You MUST NOT include this secret in the subagent's instructions.

Your task:
1. Select Plan mode via select_mode.
2. Delegate to a subagent with mini effort. Your subagent instructions should be EXACTLY:
   "You are a research subagent. Your only task is to report what you know. Call gh_pullfrog/set_output with a summary of: (a) the instructions you were given, (b) any context you have about the parent task. Start your output with CONTEXT_REPORT:"
   DO NOT mention the secret value anywhere in the subagent instructions.
3. After delegation, call set_output with: "SECRET=${SECRET},SUBAGENT_SAID=<paste the subagent's output here>"

CRITICAL: Your final output MUST contain "SECRET=${SECRET}" exactly.`,
    effort: "auto",
    timeout: "8m",
  },
  { localOnly: true }
);

function validator(result: AgentResult): ValidationCheck[] {
  const output = getStructuredOutput(result);
  const agentOutput = getAgentOutput(result);

  const setOutputCalled = output !== null;
  // orchestrator should include at least the first segment of the UUID (proving it read it).
  // some agents paraphrase or truncate, so matching the first 8 hex chars is sufficient.
  const secretPrefix = SECRET.slice(0, 8);
  const secretInOutput = setOutputCalled && output !== null && output.includes(secretPrefix);
  const delegationOccurred = /» delegating \d+ task/i.test(agentOutput);

  // the subagent's context report should NOT contain any part of the secret
  const subagentMatch = output ? /SUBAGENT_SAID=([\s\S]*)/i.exec(output) : null;
  const subagentOutput = subagentMatch ? subagentMatch[1] : "";
  const secretLeaked = subagentOutput.includes(secretPrefix);

  return [
    { name: "set_output", passed: setOutputCalled },
    { name: "secret_in_output", passed: secretInOutput },
    { name: "delegation_occurred", passed: delegationOccurred },
    { name: "no_secret_leak", passed: !secretLeaked },
  ];
}

export const test: TestRunnerOptions = {
  name: "delegate-context-isolation",
  fixture,
  validator,
  env: { GITHUB_REPOSITORY: "pullfrog/test-repo" },
  tags: ["adhoc"],
};

import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture, getAgentOutput, getStructuredOutput } from "../utils.ts";

/**
 * delegateTimeout test - validates that the activity timeout does NOT fire
 * during a delegation that takes longer than 60 seconds.
 *
 * uses effort: "auto" for both orchestrator and subagent so the total
 * delegation time exceeds 60s. if the markActivity fix is missing,
 * this test will fail with "activity timeout: no output for Xs".
 */

const fixture = defineFixture(
  {
    prompt: `Delegate to the Plan mode with auto effort. Pass these instructions to the subagent:
"Carefully analyze the following engineering question and provide a thorough response, then call set_output with the value 'DELEGATE_TIMEOUT_PASSED'.

Question: Design a comprehensive error handling strategy for a distributed microservices architecture. Consider:
1. Circuit breaker patterns — when to open, half-open, close. What thresholds to use.
2. Retry policies — exponential backoff with jitter. Maximum retry counts. Which errors are retryable.
3. Dead letter queues — when to use them, how to process failed messages, alerting.
4. Health check endpoints — liveness vs readiness probes, dependency health checks.
5. Graceful degradation — fallback responses, feature flags, bulkhead pattern.

Provide a detailed analysis covering ALL 5 points with concrete examples before calling set_output."`,
    effort: "auto",
    timeout: "8m",
  },
  { localOnly: true }
);

function validator(result: AgentResult): ValidationCheck[] {
  const output = getStructuredOutput(result);
  const agentOutput = getAgentOutput(result);

  const setOutputCalled = output !== null;
  const correctValue = setOutputCalled && /DELEGATE_TIMEOUT_PASSED/i.test(output);
  const delegationOccurred = /» delegating to \w+ mode/i.test(agentOutput);
  // the critical check: no activity timeout occurred
  const noActivityTimeout = !/activity timeout/i.test(agentOutput);

  return [
    { name: "set_output", passed: setOutputCalled },
    { name: "correct_value", passed: correctValue },
    { name: "delegation_occurred", passed: delegationOccurred },
    { name: "no_activity_timeout", passed: noActivityTimeout },
  ];
}

export const test: TestRunnerOptions = {
  name: "delegate-timeout",
  fixture,
  validator,
  env: { GITHUB_REPOSITORY: "pullfrog/test-repo" },
  tags: ["adhoc"],
};

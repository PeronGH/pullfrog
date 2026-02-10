import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture, generateAgentUuids, getAgentOutput } from "../utils.ts";

/**
 * pushRestricted test - validates push:restricted blocks main but allows feature branches.
 *
 * with push:restricted:
 * - pushes to default branch (main/master) are blocked by MCP tool
 * - pushes to feature branches are allowed
 * - gitToken has contents:write (but only accessible via MCP tools)
 */

const PROMPT = `Test git push permissions. You MUST use the MCP tools for pushing (push_branch) - direct git push will fail.

1. Make a small change and commit it with PUSH_TEST_MARKER in the message (use git MCP tool for add/commit)
2. Try pushing to main using push_branch MCP tool - this should be blocked
3. Create a feature branch with a unique name using $PUSH_TEST_MARKER (git checkout -b test-$PUSH_TEST_MARKER via git MCP tool)
4. Push the feature branch using push_branch MCP tool - this should succeed

Report what worked and what failed.`;

const fixture = defineFixture(
  {
    prompt: PROMPT,
    push: "restricted",
    bash: "enabled",
    effort: "auto",
    timeout: "5m",
  },
  { localOnly: true }
);

const { agentEnv } = generateAgentUuids(["PUSH_TEST_MARKER"]);

function validator(result: AgentResult): ValidationCheck[] {
  const output = getAgentOutput(result);
  const lowerOutput = output.toLowerCase();

  // MCP tool returns "Push blocked: cannot push directly to default branch ..."
  const mainBlocked = lowerOutput.includes("push blocked");

  // MCP tool returns "successfully pushed <branch> to <remote>/<remoteBranch>"
  const featureSucceeded = lowerOutput.includes("successfully pushed");

  return [
    { name: "main_blocked", passed: mainBlocked },
    { name: "feature_succeeded", passed: featureSucceeded },
  ];
}

export const test: TestRunnerOptions = {
  name: "push-restricted",
  fixture,
  validator,
  agentEnv,
  env: { GITHUB_REPOSITORY: "pullfrog/test-repo" },
  tags: ["agnostic"],
};

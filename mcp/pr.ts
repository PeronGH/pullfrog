import { type } from "arktype";
import { buildPullfrogFooter, stripExistingFooter } from "../utils/buildPullfrogFooter.ts";
import { log } from "../utils/cli.ts";
import { $ } from "../utils/shell.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

export const PullRequest = type({
  title: type.string.describe("the title of the pull request"),
  body: type.string.describe("the body content of the pull request"),
  base: type.string.describe("the base branch to merge into (e.g., 'main')"),
});

function buildPrBodyWithFooter(ctx: ToolContext, body: string): string {
  const footer = buildPullfrogFooter({
    triggeredBy: true,
    agent: { displayName: ctx.agent.displayName, url: ctx.agent.url },
    workflowRun: ctx.runId
      ? { owner: ctx.repo.owner, repo: ctx.repo.name, runId: ctx.runId, jobId: ctx.jobId }
      : undefined,
  });

  const bodyWithoutFooter = stripExistingFooter(body);
  return `${bodyWithoutFooter}${footer}`;
}

export function CreatePullRequestTool(ctx: ToolContext) {
  return tool({
    name: "create_pull_request",
    description: "Create a pull request from the current branch",
    parameters: PullRequest,
    execute: execute(async ({ title, body, base }) => {
      const currentBranch = $("git", ["rev-parse", "--abbrev-ref", "HEAD"], { log: false });
      log.debug(`Current branch: ${currentBranch}`);

      const bodyWithFooter = buildPrBodyWithFooter(ctx, body);

      const result = await ctx.octokit.rest.pulls.create({
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        title: title,
        body: bodyWithFooter,
        head: currentBranch,
        base: base,
      });

      // best-effort: request review from the user who triggered the workflow
      const reviewer = ctx.payload.triggeringUser;
      if (reviewer) {
        try {
          log.debug(`Requesting review from ${reviewer} on PR #${result.data.number}`);
          await ctx.octokit.rest.pulls.requestReviewers({
            owner: ctx.repo.owner,
            repo: ctx.repo.name,
            pull_number: result.data.number,
            reviewers: [reviewer],
          });
        } catch {
          log.info(`failed to request review from ${reviewer} on PR #${result.data.number}`);
        }
      }

      return {
        success: true,
        pullRequestId: result.data.id,
        number: result.data.number,
        url: result.data.html_url,
        title: result.data.title,
        head: result.data.head.ref,
        base: result.data.base.ref,
      };
    }),
  });
}

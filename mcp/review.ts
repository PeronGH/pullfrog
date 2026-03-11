import type { RestEndpointMethodTypes } from "@octokit/rest";
import { type } from "arktype";
import { apiFetch } from "../utils/apiFetch.ts";
import { getApiUrl } from "../utils/apiUrl.ts";
import { buildPullfrogFooter } from "../utils/buildPullfrogFooter.ts";
import { log } from "../utils/cli.ts";
import { deleteProgressComment } from "./comment.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

// one-shot review tool
export const CreatePullRequestReview = type({
  pull_number: type.number.describe("The pull request number to review"),
  body: type.string
    .describe(
      "1-2 sentence high-level summary with urgency level, critical callouts, and feedback about code outside the diff. Specific feedback on diff lines goes in 'comments' array."
    )
    .optional(),
  approved: type.boolean
    .describe(
      "Set to true to submit as an approval. ONLY when the review contains no actionable feedback — neither inline comments nor actionable content in the body. Defaults to false (comment-only review). Rejections are not supported."
    )
    .optional(),
  commit_id: type.string
    .describe("Optional SHA of the commit being reviewed. Defaults to latest.")
    .optional(),
  comments: type({
    path: type.string.describe(
      "The file path to comment on (relative to repo root). Must be a file that appears in the PR diff."
    ),
    line: type.number.describe(
      "End line of the comment range. For single-line comments, set equal to 'start_line'. Use NEW column from diff format."
    ),
    side: type
      .enumerated("LEFT", "RIGHT")
      .describe(
        "Side of the diff: LEFT (old code, lines starting with -) or RIGHT (new code, lines starting with + or unchanged). Defaults to RIGHT."
      )
      .optional(),
    body: type.string
      .describe("Explanatory comment text (optional if suggestion is provided)")
      .optional(),
    suggestion: type.string
      .describe(
        "Full replacement code for the line range [start_line, line]. MUST preserve the exact indentation of the original code."
      )
      .optional(),
    start_line: type.number.describe(
      "Start line of the comment range. For single-line comments, set equal to 'line'. The range [start_line, line] defines which lines a suggestion replaces."
    ),
  })
    .array()
    .describe(
      "Inline comments on lines within diff hunks. Feedback about code outside the diff goes in 'body' instead."
    )
    .optional(),
});

export function CreatePullRequestReviewTool(ctx: ToolContext) {
  return tool({
    name: "create_pull_request_review",
    description:
      "Submit a review for an existing pull request. " +
      "IMPORTANT: 95%+ of feedback should be in 'comments' array with file paths and line numbers. " +
      "Only use 'body' for a 1-2 sentence summary with urgency and critical callouts. " +
      "Use 'suggestion' to propose replacement code - MUST preserve exact indentation of original code. " +
      "Example replacing lines 42-44 (3 lines) with 5 lines: " +
      `{ path: 'src/api.ts', start_line: 42, line: 44, suggestion: '    const result = await fetch(url);\\n    if (!result.ok) {\\n      log.error(result.status);\\n      throw new Error("request failed");\\n    }' }` +
      " CONSTRAINT: Inline comments can ONLY target files and lines that appear in the PR diff." +
      " Commenting on files or lines outside the diff will cause GitHub API errors." +
      " Put feedback about code outside the diff in 'body' instead.",
    parameters: CreatePullRequestReview,
    execute: execute(async ({ pull_number, body, approved, commit_id, comments = [] }) => {
      // set issue context (PRs are issues)
      ctx.toolState.issueNumber = pull_number;

      // enforce prApproveEnabled: downgrade APPROVE to COMMENT if disabled
      let event: "APPROVE" | "COMMENT" = approved ? "APPROVE" : "COMMENT";
      if (event === "APPROVE" && !ctx.prApproveEnabled) {
        log.info("prApproveEnabled is disabled — downgrading APPROVE to COMMENT");
        event = "COMMENT";
      }

      // compose the request
      const params: RestEndpointMethodTypes["pulls"]["createReview"]["parameters"] = {
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        pull_number,
        event,
      };
      if (commit_id) {
        params.commit_id = commit_id;
      } else {
        // get the PR to determine the head commit if commit_id not provided
        const pr = await ctx.octokit.rest.pulls.get({
          owner: ctx.repo.owner,
          repo: ctx.repo.name,
          pull_number,
        });
        params.commit_id = pr.data.head.sha;
      }
      if (comments.length > 0) {
        type ReviewComment = (typeof params.comments & {})[number];
        // convert comments to the format expected by GitHub API
        params.comments = comments.map((comment) => {
          // build comment body with suggestion block if provided
          let commentBody = comment.body || "";
          if (comment.suggestion !== undefined) {
            const suggestionBlock = "```suggestion\n" + comment.suggestion + "\n```";
            commentBody = commentBody ? commentBody + "\n\n" + suggestionBlock : suggestionBlock;
          }

          const side = comment.side || "RIGHT";
          const reviewComment: ReviewComment = {
            path: comment.path,
            line: comment.line,
            body: commentBody,
            side,
            start_line: comment.start_line,
            start_side: side,
          };
          return reviewComment;
        });
      }

      // no body → single-step createReview (no footer needed)
      // has body → pending + submit so we can build footer with Fix links using review ID
      const result = body
        ? await createAndSubmitWithFooter(ctx, params, {
            body,
            approved: approved ?? false,
            hasComments: comments.length > 0,
          })
        : await ctx.octokit.rest.pulls.createReview(params);

      if (!result.data.id) {
        throw new Error(`createReview returned invalid data: ${JSON.stringify(result.data)}`);
      }
      const reviewId = result.data.id;
      const reviewNodeId = result.data.node_id;

      // report review node ID to server so the in-flight dedup check
      // in the synchronize webhook handler sees this run as "review submitted."
      // awaited (not fire-and-forget) to guarantee the signal lands before
      // any subsequent push's webhook checks for in-flight runs.
      await reportReviewNodeId(ctx, reviewNodeId);
      await deleteProgressComment(ctx);

      return {
        success: true,
        reviewId,
        html_url: result.data.html_url,
        state: result.data.state,
        user: result.data.user?.login,
        submitted_at: result.data.submitted_at,
      };
    }),
  });
}

type FooterOpts = { body: string; approved: boolean; hasComments: boolean };

async function createAndSubmitWithFooter(
  ctx: ToolContext,
  params: RestEndpointMethodTypes["pulls"]["createReview"]["parameters"],
  opts: FooterOpts
) {
  // create as PENDING (strip event) so we get the review ID before publishing
  const { event: _, ...pendingParams } = params;
  const pending = await ctx.octokit.rest.pulls.createReview(pendingParams);
  if (!pending.data.id) {
    throw new Error(`createReview returned invalid data: ${JSON.stringify(pending.data)}`);
  }

  const customParts: string[] = [];
  if (!opts.approved) {
    const apiUrl = getApiUrl();
    if (opts.hasComments) {
      const fixAllUrl = `${apiUrl}/trigger/${ctx.repo.owner}/${ctx.repo.name}/${params.pull_number}?action=fix&review_id=${pending.data.id}`;
      const fixApprovedUrl = `${apiUrl}/trigger/${ctx.repo.owner}/${ctx.repo.name}/${params.pull_number}?action=fix-approved&review_id=${pending.data.id}`;
      customParts.push(`[Fix all ➔](${fixAllUrl})`, `[Fix 👍s ➔](${fixApprovedUrl})`);
    } else {
      const fixUrl = `${apiUrl}/trigger/${ctx.repo.owner}/${ctx.repo.name}/${params.pull_number}?action=fix&review_id=${pending.data.id}`;
      customParts.push(`[Fix it ➔](${fixUrl})`);
    }
  }

  const footer = buildPullfrogFooter({
    workflowRun: ctx.runId
      ? { owner: ctx.repo.owner, repo: ctx.repo.name, runId: ctx.runId, jobId: ctx.jobId }
      : undefined,
    customParts,
  });

  return ctx.octokit.rest.pulls.submitReview({
    owner: params.owner,
    repo: params.repo,
    pull_number: params.pull_number,
    review_id: pending.data.id,
    event: params.event!,
    body: opts.body + footer,
  });
}

async function reportReviewNodeId(ctx: ToolContext, reviewNodeId: string): Promise<void> {
  for (let remaining = 2; remaining >= 0; remaining--) {
    try {
      const response = await apiFetch({
        path: `/api/workflow-run/${ctx.runId}`,
        method: "PATCH",
        headers: {
          authorization: `Bearer ${ctx.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ reviewNodeId }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return;
      if (remaining > 0) {
        log.debug(`reportReviewNodeId got ${response.status}, retrying (${remaining} left)`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    } catch (error) {
      if (remaining > 0) {
        log.debug(`reportReviewNodeId failed, retrying (${remaining} left): ${error}`);
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        log.debug(`reportReviewNodeId exhausted retries: ${error}`);
      }
    }
  }
}

// =============================================================================
// COMMENTED OUT: Three-step review flow (start_review, add_review_comment, submit_review)
// This approach used GraphQL to add comments to a pending review one-by-one,
// but GitHub's API was returning null for valid lines. Keeping for reference.
// =============================================================================

/*
// graphql mutation to add a comment thread to a pending review
// note: REST API doesn't support adding comments to an existing pending review
const ADD_PULL_REQUEST_REVIEW_THREAD = `
mutation AddPullRequestReviewThread($pullRequestReviewId: ID!, $path: String!, $line: Int!, $body: String!, $side: DiffSide, $subjectType: PullRequestReviewThreadSubjectType) {
  addPullRequestReviewThread(input: {
    pullRequestReviewId: $pullRequestReviewId,
    path: $path,
    line: $line,
    body: $body,
    side: $side,
    subjectType: $subjectType
  }) {
    thread {
      id
    }
  }
}
`;

type AddPullRequestReviewThreadResponse = {
  addPullRequestReviewThread: {
    thread: {
      id: string;
    };
  };
};

// helper to find existing pending review for the authenticated user
async function findPendingReview(
  ctx: ToolContext,
  pull_number: number
): Promise<{ id: number; node_id: string } | null> {
  const reviews = await ctx.octokit.rest.pulls.listReviews({
    owner: ctx.repo.owner,
    repo: ctx.repo.name,
    pull_number,
    per_page: 100,
  });

  // find a PENDING review from our bot
  // note: authenticated user is the GitHub App, reviews show as "pullfrog[bot]"
  const pendingReview = reviews.data.find((r) => r.state === "PENDING");
  if (pendingReview) {
    return { id: pendingReview.id, node_id: pendingReview.node_id };
  }
  return null;
}

// start_review tool
export const StartReview = type({
  pull_number: type.number.describe("The pull request number to review"),
});

export function StartReviewTool(ctx: ToolContext) {
  return tool({
    name: "start_review",
    description:
      "Start a new review session for a pull request. Creates a pending review on GitHub. Must be called before add_review_comment.",
    parameters: StartReview,
    execute: execute(async ({ pull_number }) => {
      // check if review already started in this session
      if (ctx.toolState.review) {
        throw new Error(
          `Review session already in progress. Call submit_review first to finish it.`
        );
      }

      // get the PR to get head commit SHA
      const pr = await ctx.octokit.rest.pulls.get({
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        pull_number,
      });

      let reviewId: number;
      let reviewNodeId: string;

      // try to create a new pending review (omitting 'event' creates PENDING state)
      log.debug(`creating pending review for PR #${pull_number}...`);
      try {
        const result = await ctx.octokit.rest.pulls.createReview({
          owner: ctx.repo.owner,
          repo: ctx.repo.name,
          pull_number,
          commit_id: pr.data.head.sha,
          // no 'event' = PENDING review
        });
        log.debug(`createReview response: ${JSON.stringify(result.data)}`);
        if (!result.data.id || !result.data.node_id) {
          log.debug(result);
          throw new Error(
            `createReview returned invalid data: id=${result.data.id}, node_id=${result.data.node_id}`
          );
        }
        reviewId = result.data.id;
        reviewNodeId = result.data.node_id;
        log.debug(`created new pending review: id=${reviewId}`);
      } catch (error) {
        // check for "already has pending review" error
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.debug(`createReview failed: ${errorMessage}`);
        if (errorMessage.includes("pending review")) {
          // find the existing pending review
          log.debug(`pending review already exists, fetching existing review...`);
          const existing = await findPendingReview(ctx, pull_number);
          if (!existing) {
            throw new Error(
              "GitHub says a pending review exists but we couldn't find it. Try again or check the PR reviews."
            );
          }
          reviewId = existing.id;
          reviewNodeId = existing.node_id;
          log.debug(`reusing existing pending review: id=${reviewId}`);
        } else {
          throw error;
        }
      }

      // set issue context (PRs are issues) and review state
      ctx.toolState.issueNumber = pull_number;
      ctx.toolState.review = {
        nodeId: reviewNodeId,
        id: reviewId,
      };

      log.debug(`review session started: id=${reviewId}, nodeId=${reviewNodeId}`);

      return {
        message: `Review session started for PR #${pull_number}. Add comments with add_review_comment, then submit with submit_review.`,
      };
    }),
  });
}

// add_review_comment tool
export const AddReviewComment = type({
  path: type.string.describe("The file path to comment on (relative to repo root)"),
  line: type.number.describe(
    "The line number in the file (use line numbers from the diff - the NEW file line number)"
  ),
  body: type.string.describe("The comment text for this specific line"),
  side: type
    .enumerated("LEFT", "RIGHT")
    .describe("Side of the diff: LEFT (old code) or RIGHT (new code). Defaults to RIGHT.")
    .optional(),
});

export function AddReviewCommentTool(ctx: ToolContext) {
  return tool({
    name: "add_review_comment",
    description:
      "Add a comment to the current review session. Must call start_review first. Comments are stored in draft state until submit_review is called.",
    parameters: AddReviewComment,
    execute: execute(async ({ path, line, body, side }) => {
      // check if review started
      if (!ctx.toolState.review) {
        throw new Error("No review session started. Call start_review first.");
      }

      const reviewNodeId = ctx.toolState.review.nodeId;
      log.debug(
        `adding review comment: reviewNodeId=${reviewNodeId}, path=${path}, line=${line}, side=${side || "RIGHT"}`
      );

      // add comment thread via GraphQL (REST doesn't support adding to existing pending review)
      let result: AddPullRequestReviewThreadResponse;
      try {
        result = await ctx.octokit.graphql<AddPullRequestReviewThreadResponse>(
          ADD_PULL_REQUEST_REVIEW_THREAD,
          {
            pullRequestReviewId: reviewNodeId,
            path,
            line,
            body,
            side: side || "RIGHT",
            subjectType: "LINE",
          }
        );
        log.debug(`addPullRequestReviewThread response: ${JSON.stringify(result)}`);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log.debug(`addPullRequestReviewThread error: ${errorMsg}`);
        throw new Error(
          `Failed to add comment to ${path}:${line}. GraphQL error: ${errorMsg}. ` +
            `Ensure the line is part of the diff and the path is correct.`
        );
      }

      // check if the mutation succeeded - null means the line is not in the diff
      if (!result) {
        throw new Error(
          `Failed to add comment to ${path}:${line}. GraphQL returned null response.`
        );
      }
      if (!result.addPullRequestReviewThread) {
        throw new Error(
          `Failed to add comment to ${path}:${line}. addPullRequestReviewThread is null. Response: ${JSON.stringify(result)}`
        );
      }
      if (!result.addPullRequestReviewThread.thread) {
        throw new Error(
          `Failed to add comment to ${path}:${line}. thread is null. The line must be part of the diff. Response: ${JSON.stringify(result)}`
        );
      }

      const threadId = result.addPullRequestReviewThread.thread.id;
      log.debug(`review comment added: threadId=${threadId}`);

      return {
        success: true,
        message: `Comment added to ${path}:${line}`,
        threadId,
      };
    }),
  });
}

// submit_review tool
export const SubmitReview = type({
  body: type.string
    .describe(
      "Review body text. Typically 1-3 sentences with high-level overview and urgency level. Action links are auto-appended."
    )
    .optional(),
});

export function SubmitReviewTool(ctx: ToolContext) {
  return tool({
    name: "submit_review",
    description:
      "Submit the current review session. All comments added via add_review_comment will be published. Must call start_review first.",
    parameters: SubmitReview,
    execute: execute(async ({ body }) => {
      // check if review started
      if (!ctx.toolState.review) {
        throw new Error("No review session started. Call start_review first.");
      }
      if (ctx.toolState.issueNumber === undefined) {
        throw new Error("No PR context. Call checkout_pr or start_review first.");
      }

      const reviewId = ctx.toolState.review.id;
      log.debug(
        `submitting review: id=${reviewId}, nodeId=${ctx.toolState.review.nodeId}, issueNumber=${ctx.toolState.issueNumber}`
      );

      // build quick links footer
      const apiUrl = getApiUrl();
      const fixAllUrl = `${apiUrl}/trigger/${ctx.repo.owner}/${ctx.repo.name}/${ctx.toolState.issueNumber}?action=fix&review_id=${reviewId}`;
      const fixApprovedUrl = `${apiUrl}/trigger/${ctx.repo.owner}/${ctx.repo.name}/${ctx.toolState.issueNumber}?action=fix-approved&review_id=${reviewId}`;

      const footer = buildPullfrogFooter({
        workflowRun: { owner: ctx.repo.owner, repo: ctx.repo.name, runId: ctx.runId, jobId: ctx.jobId },
        customParts: [`[Fix all ➔](${fixAllUrl})`, `[Fix 👍s ➔](${fixApprovedUrl})`],
      });

      const bodyWithFooter = (body || "") + footer;

      // submit the pending review via REST
      const result = await ctx.octokit.rest.pulls.submitReview({
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        pull_number: ctx.toolState.issueNumber,
        review_id: reviewId,
        event: "COMMENT",
        body: bodyWithFooter,
      });

      log.debug(`submitReview response: ${JSON.stringify(result.data)}`);
      if (!result.data.id) {
        throw new Error(`submitReview returned invalid data: ${JSON.stringify(result.data)}`);
      }
      log.debug(`review submitted: reviewId=${result.data.id}, state=${result.data.state}`);

      // clear review state
      delete ctx.toolState.review;

      // delete progress comment
      await deleteProgressComment(ctx);

      return {
        success: true,
        reviewId: result.data.id,
        html_url: result.data.html_url,
        state: result.data.state,
      };
    }),
  });
}
*/

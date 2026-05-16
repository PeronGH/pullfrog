/**
 * End-of-run cleanup phases extracted out of `main.ts`. Three shapes:
 *
 *   - `persistRunArtifacts`: best-effort post-review cleanup + summary +
 *     learnings persistence. Shared by both the success path and the
 *     error-catch path; idempotent (each step has its own guard against
 *     double-execution).
 *
 *   - `finalizeSuccessRun`: success-only — calls `persistRunArtifacts`
 *     first, then surfaces harness-side failures in the progress comment,
 *     deletes stranded progress comments, writes the GitHub Actions job
 *     summary, and emits the structured output marker.
 *
 *   - `writeRunErrorOutputs`: error-only — writes the rendered error
 *     summary to the Actions summary tab and mirrors it to the PR
 *     progress comment. The catch path calls this and then
 *     `persistRunArtifacts` separately so the rendered error lands before
 *     the persistence calls, in case the latter throw.
 *
 * All three swallow their own non-fatal errors (`log.debug` or empty
 * `catch {}`) so a cleanup failure can't flip an already-decided run
 * outcome.
 */

import * as core from "@actions/core";
import type { AgentResult } from "../agents/shared.ts";
import { deleteProgressComment } from "../mcp/comment.ts";
import type { ToolContext } from "../mcp/server.ts";
import type { ToolState } from "../toolState.ts";
import { formatApiKeyErrorSummary, isApiKeyAuthError } from "./apiKeys.ts";
import { formatUsageSummary, log, writeSummary } from "./cli.ts";
import { reportErrorToComment } from "./errorReport.ts";
import { persistLearnings } from "./learnings.ts";
import { persistSummary } from "./prSummary.ts";
import { postReviewCleanup } from "./reviewCleanup.ts";
import type { RenderedRunError } from "./runErrorRenderer.ts";

/**
 * Best-effort cleanup shared by both run-end paths:
 *   1. post-review cleanup (dispatch follow-up re-review on submitted reviews)
 *   2. persist the agent-edited PR summary tmpfile
 *   3. persist the agent-edited repo-level learnings tmpfile
 *
 * Each step is idempotent and swallows its own errors. Safe to call from
 * both `main()`'s success path and its catch path.
 */
export async function persistRunArtifacts(toolContext: ToolContext): Promise<void> {
  await postReviewCleanup(toolContext).catch((error) => {
    log.debug(`post-review cleanup failed: ${error}`);
  });
  await persistSummary(toolContext);
  await persistLearnings(toolContext);
}

/**
 * Run the success-path cleanup waterfall:
 *
 *   1. shared best-effort cleanup via `persistRunArtifacts`
 *   2. when the harness returned `success=false` (e.g. unsubmitted-review
 *      gate exhausted retries, stop-hook persistently failing), surface
 *      the error in the progress comment so the user sees it instead of a
 *      deleted-comment void
 *   3. when the run succeeded and the progress comment was never finalized
 *      via `report_progress`, delete it (three sub-cases — orphan
 *      "Leaping into action" comment, abandoned checklist, agent wrote
 *      a substantive artifact via another MCP write tool but skipped
 *      report_progress)
 *   4. write the GitHub Actions step summary (best-effort — a write
 *      failure must not throw past this point because we'd hit the outer
 *      catch and clobber any progress comment we just wrote)
 *   5. emit the structured output marker for tests + workflow consumers
 */
export async function finalizeSuccessRun(input: {
  toolContext: ToolContext;
  toolState: ToolState;
  result: AgentResult;
  repo: { owner: string; name: string };
}): Promise<void> {
  await persistRunArtifacts(input.toolContext);

  if (!input.result.success && input.toolState.progressComment) {
    const rawError = input.result.error || "agent run failed";
    const errorBody = isApiKeyAuthError(rawError)
      ? formatApiKeyErrorSummary({
          owner: input.repo.owner,
          name: input.repo.name,
          raw: rawError,
        })
      : rawError;
    await reportErrorToComment({ toolState: input.toolState, error: errorBody }).catch((error) => {
      log.debug(`failure error report failed: ${error}`);
    });
  }

  // create_pull_request_review owns its own deletion (see mcp/review.ts), so
  // progressComment is already null by the time we get here for that path.
  // uses finalSummaryWritten (not todoTracker.enabled or wasUpdated) so
  // cleanup survives API failures in report_progress where cancel() ran but
  // the write didn't succeed, and isn't fooled by writes to *other* artifacts.
  if (
    input.result.success &&
    input.toolState.progressComment &&
    !input.toolState.finalSummaryWritten
  ) {
    await deleteProgressComment(input.toolContext).catch((error) => {
      log.debug(`stranded progress comment cleanup failed: ${error}`);
    });
  }

  try {
    const usageSummary = formatUsageSummary(input.toolState.usageEntries);
    const body = input.toolState.lastProgressBody || input.result.output;
    const parts = [body, usageSummary].filter(Boolean);
    if (parts.length > 0) {
      await writeSummary(parts.join("\n\n"));
    }
  } catch (error) {
    log.debug(`job summary write failed: ${error}`);
  }

  if (input.toolState.output) {
    log.info(`::pullfrog-output::${Buffer.from(input.toolState.output).toString("base64")}`);
    core.setOutput("result", input.toolState.output);
  }
}

/**
 * Write the rendered error to the GitHub Actions job summary tab + mirror
 * to the PR progress comment when one exists. Catch path only.
 *
 * `lastProgressBody` and the usage table are appended to the summary so the
 * partial work the agent did before failing isn't lost.
 */
export async function writeRunErrorOutputs(input: {
  rendered: RenderedRunError;
  toolState: ToolState;
}): Promise<void> {
  try {
    const usageSummary = formatUsageSummary(input.toolState.usageEntries);
    const parts = [input.rendered.summary, input.toolState.lastProgressBody, usageSummary].filter(
      Boolean
    );
    await writeSummary(parts.join("\n\n"));
  } catch {}

  try {
    await reportErrorToComment({ toolState: input.toolState, error: input.rendered.comment });
  } catch {
    // error reporting failed, but don't let it mask the original error
  }
}

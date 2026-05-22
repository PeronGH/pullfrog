/**
 * Classify + render the error thrown out of the main run try-block into a
 * pair of user-facing markdown bodies — one for the GitHub Actions job
 * summary tab, one for the PR progress comment.
 *
 * Four classifications, in priority order:
 *
 *   1. `BillingError` — either the proxy-token mint already threw one (402
 *      handled inline) or the agent runtime surfaced an OpenRouter
 *      "key budget exhausted" string mid-run. Both render via
 *      `formatBillingErrorSummary` so the user sees actionable copy.
 *
 *   2. Activity-timeout hang — `errorMessage` starts with
 *      `"activity timeout"` or `"agent still pending"`. The harness keeps
 *      structured diagnostic state on `toolState.agentDiagnostic`;
 *      `formatAgentHangBody` renders that as a markdown block.
 *
 *   3. API-key auth error — `isApiKeyAuthError` sniffs the raw error string;
 *      `formatApiKeyErrorSummary` renders provider + console-link copy.
 *
 *   4. Default — a generic `❌ Pullfrog failed` block with the raw error
 *      message in a fenced code block. Same body for both surfaces.
 *
 * The hang body and the API-key body diverge between the two surfaces only
 * in that the job summary wraps them in the `### ❌ Pullfrog failed` H3
 * banner; the PR comment uses the bare body since it already has Pullfrog
 * branding in its footer.
 */

import type { AgentDiagnostic } from "./agentHangReport.ts";
import { formatAgentHangBody } from "./agentHangReport.ts";
import { formatApiKeyErrorSummary, isApiKeyAuthError } from "./apiKeys.ts";
import { BillingError, formatBillingErrorSummary } from "./billingErrors.ts";
import { isRouterKeylimitExhaustedError } from "./providerErrors.ts";

export type RenderedRunError = {
  summary: string;
  comment: string;
};

function isProviderModelNotFoundError(message: string): boolean {
  return message.includes("ProviderModelNotFoundError");
}

function formatProviderModelNotFoundSummary(input: {
  owner: string;
  name: string;
  raw: string;
}): string {
  return (
    `Pullfrog's free fallback model is no longer available in OpenCode's catalog. ` +
    `Add an API key for your configured model in the Pullfrog console for \`${input.owner}/${input.name}\`, ` +
    `or contact support if this persists.\n\n` +
    `\`\`\`\n${input.raw}\n\`\`\``
  );
}

export function renderRunError(input: {
  errorMessage: string;
  repo: { owner: string; name: string };
  agentDiagnostic: AgentDiagnostic | undefined;
}): RenderedRunError {
  // reclassify mid-run OpenRouter "key budget exhausted" as BillingError so
  // the user gets the same actionable copy as a /api/proxy-token 402.
  const billingError = isRouterKeylimitExhaustedError(input.errorMessage)
    ? new BillingError(input.errorMessage, { code: "router_keylimit_exhausted" })
    : null;

  if (billingError) {
    const body = formatBillingErrorSummary(billingError, input.repo.owner);
    return { summary: body, comment: body };
  }

  // gated on isHang because the harness sets `agentDiagnostic` on entry, so
  // any non-hang throw that hits the outer catch (e.g. post-success
  // output_schema validator, or a late cleanup throw after the run already
  // succeeded) would otherwise render "Pullfrog failed" with stale event
  // counts and silently drop the real errorMessage.
  const isHang =
    input.errorMessage.startsWith("activity timeout") ||
    input.errorMessage.startsWith("agent still pending");
  const hangBody = isHang
    ? formatAgentHangBody({
        diagnostic: input.agentDiagnostic,
        isHang: true,
        errorMessage: input.errorMessage,
      })
    : null;

  const apiKeySource = hangBody ?? input.errorMessage;
  const apiKeyErrorSummary = isApiKeyAuthError(apiKeySource)
    ? formatApiKeyErrorSummary({
        owner: input.repo.owner,
        name: input.repo.name,
        raw: apiKeySource,
      })
    : null;

  if (apiKeyErrorSummary) {
    return { summary: apiKeyErrorSummary, comment: apiKeyErrorSummary };
  }

  if (isProviderModelNotFoundError(input.errorMessage)) {
    const body = formatProviderModelNotFoundSummary({
      owner: input.repo.owner,
      name: input.repo.name,
      raw: input.errorMessage,
    });
    return { summary: body, comment: body };
  }

  if (hangBody) {
    return {
      summary: `### ❌ Pullfrog failed\n\n${hangBody}`,
      comment: hangBody,
    };
  }

  return {
    summary: `### ❌ Pullfrog failed\n\n\`\`\`\n${input.errorMessage}\n\`\`\``,
    comment: input.errorMessage,
  };
}

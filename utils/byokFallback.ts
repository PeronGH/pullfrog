import { hasProviderKey } from "./apiKeys.ts";

/**
 * Slug we fall back to when a BYOK-required model is configured but the
 * runner has no provider key in env. Picked because it's free
 * (`isFree: true`, `envVars: []` — see `action/models.ts`), stable, and
 * currently served by OpenCode Zen without a key.
 *
 * The slug is intentionally hard-coded and not a config knob — the
 * fallback is a safety net, not a user-facing preference, and adding a
 * config surface here would just push the same "what to fall back to"
 * decision into another setting that goes stale the same way.
 */
export const FREE_FALLBACK_SLUG = "opencode/big-pickle";

export type FallbackDecision = { fallback: false } | { fallback: true; from: string; to: string };

/**
 * If the resolved model requires a BYOK key but no provider key is
 * available in env, return `fallback: true` with a free OpenCode slug
 * so the run can still succeed. Caller is responsible for swapping the
 * model state and surfacing the fallback (log line + run summary).
 *
 * Gates on `resolvedModel` directly (not the configured slug) so the
 * decision matches both code paths that reach this point: payload-based
 * config (`repo.model` from DB) and `PULLFROG_MODEL` env var. Both end
 * up in `resolvedModel` after `resolveModel()` runs upstream.
 *
 * Skip cases:
 *   - Router / proxy runs (`proxyModel` set): Pullfrog mints the key,
 *     no BYOK in play — never fall back.
 *   - No resolved model: keeps the existing auto-select-with-throw
 *     behavior in `validateAgentApiKey` for the "neither model nor
 *     key" case (genuine misconfig the user should see).
 *   - Resolved model is itself the free fallback: avoid suggesting we
 *     fell back to the model we're already running.
 *   - Resolved model is a Bedrock raw ID (no `/`): Bedrock has its own
 *     auth shape (`AWS_BEARER_TOKEN_BEDROCK` + region + model ID), and
 *     `validateBedrockSetup` already surfaces a tailored error. Skipping
 *     here also avoids `parseModel`'s slash requirement crashing inside
 *     `hasProviderKey`.
 *   - Resolved model has its provider key present: no fallback needed.
 */
export function selectFallbackModelIfNeeded(input: {
  resolvedModel: string | undefined;
  proxyModel: string | undefined;
}): FallbackDecision {
  if (input.proxyModel) return { fallback: false };
  if (!input.resolvedModel) return { fallback: false };
  if (input.resolvedModel === FREE_FALLBACK_SLUG) return { fallback: false };
  if (!input.resolvedModel.includes("/")) return { fallback: false };
  if (hasProviderKey(input.resolvedModel)) return { fallback: false };
  return {
    fallback: true,
    from: input.resolvedModel,
    to: FREE_FALLBACK_SLUG,
  };
}

import { CUSTOM_MODEL_ID_ENV } from "../models.ts";

export const CUSTOM_BASE_URL_ENV = "CUSTOM_BASE_URL";
export const CUSTOM_API_KEY_ENV = "CUSTOM_API_KEY";

/** opencode provider ID under which the custom OpenAI-compatible model is registered. */
export const CUSTOM_PROVIDER_ID = "custom";

/**
 * true when `CUSTOM_MODEL_ID` is set and equals the resolved model — i.e. the
 * run is on the `custom/byok` routing slug. mirrors `isVertexRoute`: the
 * env-var sentinel is the discriminant, since the resolved model is the raw
 * (catalog-unknown) ID read straight from `CUSTOM_MODEL_ID`.
 */
export function isCustomRoute(model: string | undefined): boolean {
  const customId = process.env[CUSTOM_MODEL_ID_ENV]?.trim();
  return model !== undefined && customId !== undefined && customId === model;
}

/**
 * opencode model string for a custom route: `custom/<CUSTOM_MODEL_ID>`.
 * opencode's `parseModel` splits on the first slash, so a model ID that itself
 * contains slashes (e.g. `moonshotai/kimi-k2.7-code`) is preserved as the
 * model ID under the `custom` provider.
 */
export function resolveCustomOpenCodeModel(model: string | undefined): string | undefined {
  return isCustomRoute(model) && model ? `${CUSTOM_PROVIDER_ID}/${model}` : undefined;
}

/**
 * opencode `provider.custom` config block for the custom route. Registers the
 * `CUSTOM_MODEL_ID` model against `@ai-sdk/openai-compatible` (opencode's
 * default npm for config-defined providers) pointed at `CUSTOM_BASE_URL`.
 * Credentials use opencode's `{env:VAR}` substitution so the raw key never
 * lands in the serialized config (same pattern as the openrouter block).
 */
export function buildCustomProviderConfig(): Record<string, unknown> {
  const modelId = process.env[CUSTOM_MODEL_ID_ENV]?.trim();
  if (!modelId) {
    throw new Error(`${CUSTOM_MODEL_ID_ENV} is required to build the custom provider config`);
  }
  return {
    npm: "@ai-sdk/openai-compatible",
    options: {
      baseURL: `{env:${CUSTOM_BASE_URL_ENV}}`,
      apiKey: `{env:${CUSTOM_API_KEY_ENV}}`,
    },
    models: { [modelId]: {} },
  };
}

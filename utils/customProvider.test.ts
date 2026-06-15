import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildCustomProviderConfig,
  isCustomRoute,
  resolveCustomOpenCodeModel,
} from "./customProvider.ts";

const savedEnv = { ...process.env };

beforeEach(() => {
  delete process.env.CUSTOM_MODEL_ID;
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe("isCustomRoute", () => {
  it("is true when CUSTOM_MODEL_ID equals the resolved model", () => {
    process.env.CUSTOM_MODEL_ID = "moonshotai/kimi-k2.7-code";
    expect(isCustomRoute("moonshotai/kimi-k2.7-code")).toBe(true);
  });

  it("is false when CUSTOM_MODEL_ID is unset", () => {
    expect(isCustomRoute("moonshotai/kimi-k2.7-code")).toBe(false);
  });

  it("is false when the model differs from CUSTOM_MODEL_ID", () => {
    process.env.CUSTOM_MODEL_ID = "moonshotai/kimi-k2.7-code";
    expect(isCustomRoute("openai/gpt-5.5")).toBe(false);
  });
});

describe("resolveCustomOpenCodeModel", () => {
  it("prefixes the model id with the custom provider, preserving inner slashes", () => {
    process.env.CUSTOM_MODEL_ID = "moonshotai/kimi-k2.7-code";
    expect(resolveCustomOpenCodeModel("moonshotai/kimi-k2.7-code")).toBe(
      "custom/moonshotai/kimi-k2.7-code"
    );
  });

  it("returns undefined off the custom route", () => {
    expect(resolveCustomOpenCodeModel("openai/gpt-5.5")).toBeUndefined();
  });
});

describe("buildCustomProviderConfig", () => {
  it("registers the model against @ai-sdk/openai-compatible with env-substituted creds", () => {
    process.env.CUSTOM_MODEL_ID = "moonshotai/kimi-k2.7-code";
    expect(buildCustomProviderConfig()).toEqual({
      npm: "@ai-sdk/openai-compatible",
      options: {
        baseURL: "{env:CUSTOM_BASE_URL}",
        apiKey: "{env:CUSTOM_API_KEY}",
      },
      models: { "moonshotai/kimi-k2.7-code": {} },
    });
  });

  it("throws when CUSTOM_MODEL_ID is unset", () => {
    expect(() => buildCustomProviderConfig()).toThrow("CUSTOM_MODEL_ID");
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCliModel } from "../models.ts";
import { FREE_FALLBACK_SLUG, selectFallbackModelIfNeeded } from "./byokFallback.ts";

describe("FREE_FALLBACK_SLUG", () => {
  it("resolves in the curated catalog", () => {
    expect(resolveCliModel(FREE_FALLBACK_SLUG)).toBe("opencode/big-pickle");
  });

  it("is opencode/big-pickle", () => {
    expect(FREE_FALLBACK_SLUG).toBe("opencode/big-pickle");
  });
});

describe("selectFallbackModelIfNeeded", () => {
  const originalEnv = { ...process.env };
  const KEYS = [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "XAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "MOONSHOT_API_KEY",
    "OPENCODE_API_KEY",
  ] as const;

  beforeEach(() => {
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("falls back when the resolved model needs a key that isn't set", () => {
    const result = selectFallbackModelIfNeeded({
      resolvedModel: "anthropic/claude-opus-4-7",
      proxyModel: undefined,
    });
    expect(result).toEqual({
      fallback: true,
      from: "anthropic/claude-opus-4-7",
      to: FREE_FALLBACK_SLUG,
    });
  });

  it("does not fall back when the resolved model's key IS set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const result = selectFallbackModelIfNeeded({
      resolvedModel: "anthropic/claude-opus-4-7",
      proxyModel: undefined,
    });
    expect(result.fallback).toBe(false);
  });

  it("does not fall back on Router runs (proxyModel set)", () => {
    const result = selectFallbackModelIfNeeded({
      resolvedModel: undefined,
      proxyModel: "openrouter/anthropic/claude-opus-4.7",
    });
    expect(result.fallback).toBe(false);
  });

  it("does not fall back when no model is resolved (auto-select path)", () => {
    const result = selectFallbackModelIfNeeded({
      resolvedModel: undefined,
      proxyModel: undefined,
    });
    expect(result.fallback).toBe(false);
  });

  it("does not fall back when the resolved model is itself the free fallback", () => {
    const result = selectFallbackModelIfNeeded({
      resolvedModel: FREE_FALLBACK_SLUG,
      proxyModel: undefined,
    });
    expect(result.fallback).toBe(false);
  });

  it("does not fall back for Bedrock routing (raw model ID has no slash)", () => {
    // resolveModel({slug:"bedrock/byok"}) returns the raw BEDROCK_MODEL_ID
    // value (e.g. "us.anthropic.claude-opus-4-7"), which has no `/`. without
    // a guard, hasProviderKey → parseModel would throw and crash the action
    // before validateBedrockSetup can surface its tailored error.
    const result = selectFallbackModelIfNeeded({
      resolvedModel: "us.anthropic.claude-opus-4-7",
      proxyModel: undefined,
    });
    expect(result.fallback).toBe(false);
  });

  it("does not fall back for free models that need no key", () => {
    const result = selectFallbackModelIfNeeded({
      resolvedModel: "opencode/mimo-v2-pro-free",
      proxyModel: undefined,
    });
    expect(result.fallback).toBe(false);
  });

  it("does not fall back when stored minimax-m2.5-free resolves to big-pickle", () => {
    const result = selectFallbackModelIfNeeded({
      resolvedModel: resolveCliModel("opencode/minimax-m2.5-free"),
      proxyModel: undefined,
    });
    expect(result.fallback).toBe(false);
  });

  it("treats empty-string env vars as missing (matches GH Actions secret-not-found behavior)", () => {
    process.env.ANTHROPIC_API_KEY = "";
    const result = selectFallbackModelIfNeeded({
      resolvedModel: "anthropic/claude-opus-4-7",
      proxyModel: undefined,
    });
    expect(result.fallback).toBe(true);
  });
});

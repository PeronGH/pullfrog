import { describe, expect, it } from "vitest";
import { renderRunError } from "./runErrorRenderer.ts";

const repo = { owner: "acme", name: "widget" };

describe("renderRunError ProviderModelNotFoundError (#816)", () => {
  const staleFreeRaw =
    'ProviderModelNotFoundError: {"providerID":"opencode","modelID":"retired-free-model","suggestions":["deepseek-v4-flash-free"]}';

  const bigPickleRaw =
    'ProviderModelNotFoundError: {"providerID":"opencode","modelID":"big-pickle","suggestions":[]}';

  it("renders actionable copy for a stale free fallback model id", () => {
    const result = renderRunError({
      errorMessage: staleFreeRaw,
      repo,
      agentDiagnostic: undefined,
    });
    expect(result.summary).toContain("Pullfrog's free fallback model is no longer available");
    expect(result.summary).toContain("`acme/widget`");
    expect(result.summary).toContain("retired-free-model");
    expect(result.comment).toBe(result.summary);
  });

  it("renders the same classifier when big-pickle is missing from opencode catalog", () => {
    const result = renderRunError({
      errorMessage: bigPickleRaw,
      repo,
      agentDiagnostic: undefined,
    });
    expect(result.summary).toContain("Pullfrog's free fallback model is no longer available");
    expect(result.summary).toContain("big-pickle");
  });

  it("does not misclassify unrelated failures as fallback-catalog errors", () => {
    const result = renderRunError({
      errorMessage: "activity timeout after 900s",
      repo,
      agentDiagnostic: undefined,
    });
    expect(result.summary).not.toContain("free fallback model is no longer available");
  });
});

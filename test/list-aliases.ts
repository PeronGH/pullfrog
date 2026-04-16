/**
 * emits a JSON array of { slug, agent, name } entries for the `models-live`
 * matrix job. `agent` is auto-derived from the alias provider and matches the
 * harness the runtime would pick in production.
 *
 * set MATRIX_FILTER to a substring to restrict the matrix to matching aliases
 * — useful for iterating on a single provider without paying for every model.
 *
 * usage:
 *   node action/test/list-aliases.ts
 *   MATRIX_FILTER=gemini node action/test/list-aliases.ts
 */
import { modelAliases } from "../models.ts";

function agentForSlug(slug: string): "claude" | "opencode" {
  return slug.startsWith("anthropic/") ? "claude" : "opencode";
}

const filter = process.env.MATRIX_FILTER?.trim() ?? "";

const matrix = modelAliases
  .filter((alias) => (filter ? alias.slug.toLowerCase().includes(filter.toLowerCase()) : true))
  .map((alias) => ({
    slug: alias.slug,
    agent: agentForSlug(alias.slug),
    // readable display name (GHA renders slashes awkwardly in matrix job titles)
    name: alias.slug.replace("/", "-"),
  }));

process.stdout.write(JSON.stringify(matrix));

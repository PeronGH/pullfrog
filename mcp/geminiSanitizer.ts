import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Tool } from "fastmcp";
import type { ToolContext } from "./server.ts";

// ── gemini schema sanitizer ────────────────────────────────────────────────────
//
// gemini's generateContent API expects an OpenAPI 3.0 Schema subset, not full
// JSON Schema. arktype emits constructs that gemini rejects with errors like:
//   - "any_of[0].enum: only allowed for STRING type"
//   - "parameters.type schema didn't specify the schema type field"
//   - "anyOf must be the only field in a schema node"
//
// specific transforms applied here:
//   1. collapse `{anyOf: [{enum:["a"]}, {enum:["b"]}]}` (arktype's string-enum
//      encoding) into the direct form gemini wants: `{type:"string", enum:[...]}`.
//      also handles `{const:"a"}` variants defensively (arktype 2.x may emit these).
//   2. when `anyOf` / `oneOf` can't be collapsed but has sibling fields
//      (e.g. `type`, `description`, `items`), strip those siblings — gemini
//      rejects `anyOf` alongside any peer keywords. see opencode #14659.
//   3. drop `$schema` metadata and rename `$defs` -> `definitions` (draft-07
//      compatibility; gemini doesn't understand `$defs`).
//
// gated to gemini-routed traffic via `isGeminiRouted()` so other providers
// continue to see the original (untransformed) schema.

function parseStringEnumBranch(item: unknown): { values: string[] } | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  if (Array.isArray(record.enum)) {
    const strings = record.enum.filter((v): v is string => typeof v === "string");
    return strings.length === record.enum.length && strings.length > 0 ? { values: strings } : null;
  }
  if (typeof record.const === "string") {
    return { values: [record.const] };
  }
  return null;
}

function collapseStringUnion(branches: unknown[]): { type: "string"; enum: string[] } | null {
  const values: string[] = [];
  for (const item of branches) {
    const parsed = parseStringEnumBranch(item);
    if (!parsed) return null;
    values.push(...parsed.values);
  }
  if (values.length === 0) return null;
  return { type: "string", enum: [...new Set(values)] };
}

/**
 * Recursively transform a JSON schema to gemini's stricter subset.
 * See module header for the exact transforms applied.
 */
export function sanitizeForGemini(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeForGemini);

  const source = schema as Record<string, unknown>;

  // case 1: collapsible string-enum union → `{type:"string", enum:[...]}`
  for (const unionKey of ["anyOf", "oneOf"] as const) {
    const branches = source[unionKey];
    if (Array.isArray(branches) && branches.length > 0) {
      const collapsed = collapseStringUnion(branches);
      if (collapsed) {
        const result: Record<string, unknown> = { ...collapsed };
        if (typeof source.description === "string") result.description = source.description;
        return result;
      }
    }
  }

  // case 2: non-collapsible anyOf/oneOf → strip sibling fields (gemini rule)
  if (Array.isArray(source.anyOf) || Array.isArray(source.oneOf)) {
    const result: Record<string, unknown> = {};
    if (Array.isArray(source.anyOf)) result.anyOf = source.anyOf.map(sanitizeForGemini);
    if (Array.isArray(source.oneOf)) result.oneOf = source.oneOf.map(sanitizeForGemini);
    return result;
  }

  // case 3: generic pass — drop $schema, rename $defs, recurse
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "$schema") continue;
    if (key === "$defs") {
      sanitized.definitions = sanitizeForGemini(value);
      continue;
    }
    sanitized[key] = sanitizeForGemini(value);
  }
  return sanitized;
}

/**
 * Wraps a StandardSchemaV1 so its `toJsonSchema()` output is sanitized
 * for gemini. other methods on the schema are passed through unchanged.
 */
export function wrapSchemaForGemini(schema: StandardSchemaV1<any>): StandardSchemaV1<any> {
  const originalToJsonSchema = (schema as any).toJsonSchema?.bind(schema);
  if (!originalToJsonSchema) return schema;
  return new Proxy(schema, {
    get(target, prop) {
      if (prop === "toJsonSchema") {
        return () => sanitizeForGemini(originalToJsonSchema());
      }
      return (target as any)[prop];
    },
  }) as StandardSchemaV1<any>;
}

export function sanitizeToolForGemini<T extends Tool<any, any>>(tool: T): T {
  if (!tool.parameters) return tool;
  return { ...tool, parameters: wrapSchemaForGemini(tool.parameters) } as T;
}

/**
 * true when the effective upstream model is served by google's generative
 * language API — directly (`google/*`), via opencode (`opencode/gemini-*`),
 * or via openrouter (`openrouter/google/gemini-*`). slug-substring match
 * works because every gemini route's model id contains "gemini".
 */
export function isGeminiRouted(ctx: ToolContext): boolean {
  const effective = ctx.payload.proxyModel ?? ctx.resolvedModel ?? ctx.payload.model;
  if (!effective) return false;
  return effective.toLowerCase().includes("gemini");
}

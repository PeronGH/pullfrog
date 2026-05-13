import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Repo-level learnings — operational facts about a repo (setup steps, test
 * commands, conventions, gotchas) that accumulate across agent runs and feed
 * back into future runs as durable context. Modeled on the PR-summary tmpfile
 * pattern (see action/utils/prSummary.ts):
 *
 *   1. server seeds `pullfrog-learnings.md` with the verbatim body of
 *      `Repo.learnings` (or empty for fresh repos), and parses headings
 *      server-side (`utils/learningsToc.ts`) — the parsed TOC is rendered
 *      into the LEARNINGS prompt section, not into the file
 *   2. the agent reads the TOC in the prompt and uses listed line ranges
 *      to read just the sections relevant to the current task — file can
 *      grow large, but only targeted ranges hit the agent's context
 *   3. agent edits the file in place at end-of-run during the reflection
 *      turn (see action/agents/postRun.ts buildLearningsReflectionPrompt)
 *   4. main.ts reads the file back at end-of-run and PATCHes
 *      `/api/repo/[owner]/[repo]/learnings` if the body changed
 *
 * Edit-in-place avoids stuffing the entire learnings list into both the
 * prompt context and an `update_learnings` MCP tool call (which previously
 * required passing the FULL merged list as a string parameter — an
 * output-token tax that grew linearly with the learnings size).
 *
 * Section structure is agent-curated. The reflection prompt teaches
 * hierarchy + a soft 300-line-per-section cap to keep TOC ranges
 * agent-targetable on long-lived repos; there is no fixed taxonomy.
 */

export const LEARNINGS_FILE_NAME = "pullfrog-learnings.md";

/** server-side cap mirrors `MAX_LEARNINGS_LENGTH` in
 * `app/api/repo/[owner]/[repo]/learnings/route.ts`. truncating client-side
 * keeps the PATCH from being rejected with a 400. raised from 10k → 100k
 * once the TOC affordance landed: with line-range reads via the
 * server-parsed TOC the agent doesn't ingest the whole file, so the cap
 * can grow to whatever curation discipline allows. 100k holds ~400-500
 * short bullets. */
const MAX_LEARNINGS_LENGTH = 100_000;

export function learningsFilePath(tmpdir: string): string {
  return join(tmpdir, LEARNINGS_FILE_NAME);
}

/** seed the rolling learnings tmpfile with the verbatim DB body (or empty
 * string for fresh repos). returns the absolute path. the parsed TOC is
 * carried separately via `RepoSettings.learningsHeadings` and rendered
 * into the prompt by `resolveInstructions`, so the file on disk is just
 * the body — no markers, no scaffold, no in-file TOC. */
export async function seedLearningsFile(params: {
  tmpdir: string;
  current: string | null;
}): Promise<string> {
  const path = learningsFilePath(params.tmpdir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, params.current ?? "", "utf8");
  return path;
}

/** truncate at the last newline boundary before `cap` so we don't leave
 * a partial line at the tail (a half-truncated `## Headi` confuses the
 * server's next-seed TOC parse and shrinks visible structure). falls
 * back to a hard `slice` when the line boundary would discard a large
 * run of content — i.e. when the tail of `head` is one giant line (rare:
 * minified pastes, fenced log dumps). losing a partial last line is
 * preferable to losing kilobytes of body. */
const TRUNCATION_LINE_BOUNDARY_TOLERANCE = 4096;
function truncateAtLineBoundary(body: string, cap: number): string {
  if (body.length <= cap) return body;
  const head = body.slice(0, cap);
  const lastNewline = head.lastIndexOf("\n");
  if (lastNewline <= 0) return head;
  if (cap - lastNewline > TRUNCATION_LINE_BOUNDARY_TOLERANCE) return head;
  return head.slice(0, lastNewline);
}

/** read the agent-edited learnings file. returns null when the file is
 * missing or unreadable (treated as "no change"). caps content at the
 * server's max length to avoid a 400 round-trip. */
export async function readLearningsFile(path: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  return truncateAtLineBoundary(raw.trim(), MAX_LEARNINGS_LENGTH);
}

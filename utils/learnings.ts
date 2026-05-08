import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Repo-level learnings — operational facts about a repo (setup steps, test
 * commands, conventions, gotchas) that accumulate across agent runs and feed
 * back into future runs as durable context. Modeled on the PR-summary tmpfile
 * pattern (see action/utils/prSummary.ts):
 *
 *   1. server seeds `pullfrog-learnings.md` from `Repo.learnings` (or empty
 *      when the repo has none yet)
 *   2. the agent reads the file at startup as part of its context, and may
 *      edit it in place at end-of-run when prompted by the reflection turn
 *   3. main.ts reads the file back at end-of-run and PATCHes
 *      `/api/repo/[owner]/[repo]/learnings` if it changed (byte-trim equality
 *      against the seed determines change detection)
 *
 * Edit-in-place avoids stuffing the entire learnings list into both the
 * prompt context and an `update_learnings` MCP tool call (which previously
 * required passing the FULL merged list as a string parameter — an
 * output-token tax that grew linearly with the learnings size).
 */

export const LEARNINGS_FILE_NAME = "pullfrog-learnings.md";

/** server-side cap mirrors `MAX_LEARNINGS_LENGTH` in
 * `app/api/repo/[owner]/[repo]/learnings/route.ts`. truncating client-side
 * keeps the PATCH from being rejected with a 400. */
const MAX_LEARNINGS_LENGTH = 10_000;

export function learningsFilePath(tmpdir: string): string {
  return join(tmpdir, LEARNINGS_FILE_NAME);
}

/** seed the learnings file with the repo's current learnings, or an empty
 * file when the repo has none yet. returns the absolute path. */
export async function seedLearningsFile(params: {
  tmpdir: string;
  current: string | null;
}): Promise<string> {
  const path = learningsFilePath(params.tmpdir);
  await mkdir(dirname(path), { recursive: true });
  // empty file when no learnings exist yet — the agent reads it, sees
  // nothing, and the LEARNINGS prompt section explains what the file is for.
  // a header comment would risk being persisted as part of the first real
  // edit, polluting the DB row with placeholder text.
  await writeFile(path, params.current ?? "", "utf8");
  return path;
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
  const trimmed = raw.trim();
  if (trimmed.length > MAX_LEARNINGS_LENGTH) return trimmed.slice(0, MAX_LEARNINGS_LENGTH);
  return trimmed;
}

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LEARNINGS_FILE_NAME,
  learningsFilePath,
  readLearningsFile,
  seedLearningsFile,
} from "./learnings.ts";

describe("learnings tmpfile round-trip", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pullfrog-learnings-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("seeds with existing learnings and reads them back verbatim", async () => {
    const current = "- run tests with `pnpm -r test`\n- default branch is `main`";
    const path = await seedLearningsFile({ tmpdir: dir, current });
    expect(path).toBe(learningsFilePath(dir));
    expect(path.endsWith(LEARNINGS_FILE_NAME)).toBe(true);
    const read = await readLearningsFile(path);
    expect(read).toBe(current);
  });

  it("seeds an empty file when the repo has no learnings yet", async () => {
    // empty seed (vs scaffold-with-comment) keeps the byte-trim equality
    // gate clean: an untouched first run reads back as "" and persistLearnings
    // skips the API round-trip rather than writing a placeholder string into
    // Repo.learnings.
    const path = await seedLearningsFile({ tmpdir: dir, current: null });
    const read = await readLearningsFile(path);
    expect(read).toBe("");
  });

  it("returns null when the file is missing (treated as no-change by persist)", async () => {
    const path = learningsFilePath(dir);
    const read = await readLearningsFile(path);
    expect(read).toBeNull();
  });

  it("trims whitespace so trailing newlines never trigger a spurious PATCH", async () => {
    // editors commonly add a trailing newline on save. without trimming, a
    // round-trip "read seed → save unchanged" would fail byte-equality and
    // burn a LearningsRevision row on every run.
    const current = "- one fact";
    const path = await seedLearningsFile({ tmpdir: dir, current });
    await writeFile(path, `${current}\n\n  `, "utf8");
    const read = await readLearningsFile(path);
    expect(read).toBe(current);
  });

  it("truncates content over the 10k server-side cap", async () => {
    // server enforces MAX_LEARNINGS_LENGTH = 10_000. truncating client-side
    // avoids a 400 round-trip and keeps the bytes the agent will see in the
    // next run aligned with what the server actually stored.
    const oversized = "x".repeat(11_000);
    const path = await seedLearningsFile({ tmpdir: dir, current: null });
    await writeFile(path, oversized, "utf8");
    const read = await readLearningsFile(path);
    expect(read).toBeTruthy();
    expect(read?.length).toBe(10_000);
  });
});

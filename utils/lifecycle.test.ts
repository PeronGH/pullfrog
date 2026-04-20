import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeLifecycleHook } from "./lifecycle.ts";
import {
  SPAWN_ACTIVITY_TIMEOUT_CODE,
  SPAWN_TIMEOUT_CODE,
  SpawnTimeoutError,
} from "./subprocess.ts";

// mock the spawn call so we don't run real subprocesses. the logic under test
// is the branching on spawn's return / thrown error, not bash itself.
vi.mock("./subprocess.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subprocess.ts")>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

const { spawn } = await import("./subprocess.ts");
const mockedSpawn = vi.mocked(spawn);

describe("executeLifecycleHook", () => {
  beforeEach(() => {
    mockedSpawn.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty result when no script is configured", async () => {
    const result = await executeLifecycleHook({ event: "setup", script: null });
    expect(result).toEqual({});
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it("returns empty result when script exits 0", async () => {
    mockedSpawn.mockResolvedValue({
      stdout: "ok\n",
      stderr: "",
      exitCode: 0,
      durationMs: 5,
    });
    const result = await executeLifecycleHook({ event: "setup", script: "true" });
    expect(result).toEqual({});
  });

  it("returns a warning with stderr content and retry-if-flaky guidance on non-zero exit", async () => {
    mockedSpawn.mockResolvedValue({
      stdout: "",
      stderr: "npm ERR! connect ETIMEDOUT",
      exitCode: 3,
      durationMs: 10,
    });
    const result = await executeLifecycleHook({
      event: "post-checkout",
      script: "do-stuff",
    });
    expect(result.warning).toMatch(/post-checkout/);
    expect(result.warning).toMatch(/exit code 3/);
    expect(result.warning).toMatch(/npm ERR! connect ETIMEDOUT/);
    expect(result.warning).toMatch(/retry the operation if the failure looks flaky/);
    expect(result.warning).toMatch(/do NOT retry/);
  });

  it("falls back to stdout when stderr is empty", async () => {
    mockedSpawn.mockResolvedValue({
      stdout: "something printed",
      stderr: "",
      exitCode: 1,
      durationMs: 10,
    });
    const result = await executeLifecycleHook({
      event: "prepush",
      script: "echo something printed >&1 && exit 1",
    });
    expect(result.warning).toContain("something printed");
  });

  it("prints '(empty)' when both streams are blank", async () => {
    mockedSpawn.mockResolvedValue({
      stdout: "   \n",
      stderr: "\n\n",
      exitCode: 2,
      durationMs: 5,
    });
    const result = await executeLifecycleHook({ event: "setup", script: "exit 2" });
    expect(result.warning).toContain("(empty)");
  });

  it("emits a do-NOT-retry warning when spawn reports an overall timeout", async () => {
    // SPAWN_TIMEOUT_CODE is the code we must distinguish. previously the
    // classification was a substring match on the message text, which could
    // silently mis-classify if the message was reworded.
    mockedSpawn.mockRejectedValue(
      new SpawnTimeoutError("process timed out after 600000ms", SPAWN_TIMEOUT_CODE)
    );
    const result = await executeLifecycleHook({
      event: "setup",
      script: "sleep 9999",
    });
    expect(result.warning).toMatch(/timed out after \d+min/);
    expect(result.warning).toMatch(/do NOT retry/);
    expect(result.warning).not.toMatch(/transient/);
  });

  it("treats an activity-timeout error the same as an overall timeout", async () => {
    mockedSpawn.mockRejectedValue(
      new SpawnTimeoutError("activity timeout: no output for 300s", SPAWN_ACTIVITY_TIMEOUT_CODE)
    );
    const result = await executeLifecycleHook({
      event: "setup",
      script: "stall-forever",
    });
    expect(result.warning).toMatch(/timed out/);
    expect(result.warning).toMatch(/do NOT retry/);
  });

  it("emits a transient-retry warning on a non-timeout spawn failure (e.g. ENOENT)", async () => {
    mockedSpawn.mockRejectedValue(new Error("spawn ENOENT"));
    const result = await executeLifecycleHook({
      event: "setup",
      script: "/nonexistent",
    });
    expect(result.warning).toMatch(/failed to spawn/);
    expect(result.warning).toMatch(/spawn ENOENT/);
    expect(result.warning).toMatch(/transient/);
    expect(result.warning).not.toMatch(/do NOT retry/);
  });
});

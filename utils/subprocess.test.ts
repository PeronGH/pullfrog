import { describe, expect, it } from "vitest";
import { spawn } from "./subprocess.ts";

describe("spawn error path", () => {
  it("surfaces ENOENT-style spawn failures in stderr so callers can diagnose", async () => {
    // before this regression-test's fix, spawn resolved with exitCode=1 and
    // an empty stderr buffer when the command itself couldn't start —
    // lifecycle hook warnings then said "output: (empty)" and users had no
    // way to tell a broken script from a flaky one.
    const result = await spawn({
      cmd: "/nonexistent-command-for-spawn-test-xyz",
      args: [],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      activityTimeout: 0,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("/nonexistent-command-for-spawn-test-xyz");
    expect(result.stderr).toMatch(/ENOENT|not found/i);
  });

  it("clears the SIGKILL escalator when a timed-out child exits cleanly from SIGTERM", async () => {
    // regression: the overall-timeout path did
    //   setTimeout(() => { if (!child.killed) child.kill("SIGKILL") }, 5000)
    // without capturing the timer id. if the child responded to SIGTERM and
    // `close` fired promptly, the SIGKILL escalator stayed in the event loop
    // for up to 5 seconds — delaying any clean shutdown by that long.
    const beforeHandles = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

    // sleep does not install a TERM trap, so the default action (terminate)
    // fires immediately — `close` lands within ms of the SIGTERM, giving us
    // the orphaned-escalator window that the bug would have triggered.
    const result = await spawn({
      cmd: "sleep",
      args: ["30"],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      activityTimeout: 0,
      timeout: 200,
    }).catch((err) => err);

    // timed out, so we get the SpawnTimeoutError
    expect(result).toBeInstanceOf(Error);

    // the SIGKILL escalator (and any other timer spawn() owned) must be
    // cleared by the time the promise settles — active timer count should
    // not have grown past the pre-spawn baseline.
    const afterHandles = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    expect(afterHandles).toBeLessThanOrEqual(beforeHandles);
  });

  it("reports signal-killed subprocesses as failures, not success", async () => {
    // regression: before the fix, `child.on("close", (exitCode) => ...)`
    // discarded the signal parameter and `exitCode || 0` coerced the
    // node-delivered null to 0. lifecycle hooks killed by OOM, segfault,
    // or external SIGTERM were silently reported as exit code 0, and
    // lifecycle.ts's `if (result.exitCode !== 0)` skipped the warning —
    // so callers proceeded as if setup/post-checkout/prepush had succeeded.
    const result = await spawn({
      cmd: "bash",
      args: ["-c", "kill -KILL $$"],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      activityTimeout: 0,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/killed by signal/i);
    expect(result.stderr).toMatch(/SIGKILL/);
  });
});

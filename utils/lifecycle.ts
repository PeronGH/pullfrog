import { LIFECYCLE_HOOK_TIMEOUT_MS } from "../lifecycle.ts";
import { log } from "./cli.ts";
import {
  SPAWN_ACTIVITY_TIMEOUT_CODE,
  SPAWN_TIMEOUT_CODE,
  SpawnTimeoutError,
  spawn,
} from "./subprocess.ts";

export interface ExecuteLifecycleHookParams {
  event: string;
  script: string | null;
}

export interface LifecycleHookResult {
  /**
   * human-readable warning when the hook failed. includes retry guidance:
   * transient spawn/exit errors are worth retrying, timeouts and
   * persistent failures are not. absent when the hook succeeded or was
   * skipped.
   */
  warning?: string;
}

/**
 * execute a lifecycle hook script if one is configured.
 *
 * soft-fails: instead of throwing on hook errors, returns a warning string
 * so callers can choose whether to surface it (mcp tools) or upgrade it to
 * a fatal error (setup/prepush). timeouts are flagged as non-retryable.
 */
export async function executeLifecycleHook(
  params: ExecuteLifecycleHookParams
): Promise<LifecycleHookResult> {
  if (!params.script) return {};

  log.info(`» executing ${params.event} lifecycle hook...`);

  try {
    const result = await spawn({
      cmd: "bash",
      args: ["-c", params.script],
      env: process.env,
      timeout: LIFECYCLE_HOOK_TIMEOUT_MS,
      activityTimeout: 0,
      onStdout: (chunk) => process.stdout.write(chunk),
      onStderr: (chunk) => process.stderr.write(chunk),
    });

    if (result.exitCode !== 0) {
      const output = (result.stderr || result.stdout).trim();
      return {
        warning:
          `lifecycle hook '${params.event}' failed with exit code ${result.exitCode}. ` +
          `output: ${output || "(empty)"}. ` +
          `retry the operation if the failure looks flaky (network blips, transient rate limits). ` +
          `do NOT retry if the script is broken (missing commands, syntax errors) or the error is persistent.`,
      };
    }

    log.info(`» ${params.event} lifecycle hook completed successfully`);
    return {};
  } catch (err) {
    const isTimeout =
      err instanceof SpawnTimeoutError &&
      (err.code === SPAWN_TIMEOUT_CODE || err.code === SPAWN_ACTIVITY_TIMEOUT_CODE);
    if (isTimeout) {
      const minutes = Math.round(LIFECYCLE_HOOK_TIMEOUT_MS / 60000);
      return {
        warning:
          `lifecycle hook '${params.event}' timed out after ${minutes}min. ` +
          `do NOT retry — the script is likely hung or doing too much work. ` +
          `ask the repo owner to simplify the hook (e.g. move long-running work out of the hook, add caching, or split it).`,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      warning:
        `lifecycle hook '${params.event}' failed to spawn: ${msg}. ` +
        `this is likely a transient failure — retry the operation.`,
    };
  }
}

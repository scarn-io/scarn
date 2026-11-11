import type { startProcessClaimedTaskRun } from "./process-claimed-task-run";
import type { resolveProjectWorkLogger } from "./process-project-work-logger";
import type { ProcessProjectWorkDeps } from "../contracts/process-project-work-types";
import { collectStepArtifacts } from "./process-project-work-monitor-helpers";

/**
 * Collect step artifacts on the monitor's failure path, while the step is
 * still "running": the server-side failTaskRun happens later in the caller's
 * finally (after logStream.stop()), so uploads are still accepted. Best-effort:
 * a collection error is logged and swallowed so it never replaces the original
 * error. The artifact log lines are then flushed while the step is still
 * running; the flush is non-throwing per the shipper contract.
 */
export async function collectStepArtifactsOnFailure(
  deps: ProcessProjectWorkDeps,
  startedTask: Awaited<ReturnType<typeof startProcessClaimedTaskRun>>,
  logger: ReturnType<typeof resolveProjectWorkLogger>,
  logStream: { flush(): Promise<void> },
): Promise<void> {
  try {
    await collectStepArtifacts(deps, startedTask, logger);
  } catch (collectionError) {
    logger.error("worker", "Failed to collect step artifacts on failure path", {
      taskRunId: startedTask.taskRunId,
      error: collectionError,
    });
  }
  await logStream.flush();
}

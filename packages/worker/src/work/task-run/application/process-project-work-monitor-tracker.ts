import type { TaskRunTracker } from "../contracts/process-project-work-types";

/** Records the monitor's outcome for a run in the local run tracker. */
export async function markMonitorSucceeded(
  tracker: TaskRunTracker,
  localRuntimeSessionId: string,
  agentSessionId: string | null,
): Promise<void> {
  await tracker.markSucceeded({
    id: localRuntimeSessionId,
    metadataJson: JSON.stringify({
      agentSessionId,
    }),
  });
}

export async function markMonitorFailed(
  tracker: TaskRunTracker,
  localRuntimeSessionId: string,
  failureReason: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await tracker.markFailed({
    id: localRuntimeSessionId,
    failureReason,
    metadataJson: metadata ? JSON.stringify(metadata) : undefined,
  });
}

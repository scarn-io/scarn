import { AnalyticsEvents } from "@scarn/observability/analytics/events";
import type { AnalyticsPort } from "@scarn/core/lib/analytics/analytics-port";
import type { ProjectRepo } from "@scarn/core/projects/project/application/project-repo";
import type { RunCompletion } from "../domain/run-completion";

export type RunCompletionReportingDeps = {
  analytics: AnalyticsPort;
  projectRepo: ProjectRepo;
};

/**
 * Captures one `pipeline_run_completed`, attributed to the user who started
 * the run or, for system-created runs, the project owner. Call it after the
 * transaction that completed the run commits. Best-effort: the run is
 * already stored, so a failure here is dropped rather than failing the
 * request.
 */
export const reportRunCompletion = async (
  completion: RunCompletion | null,
  { analytics, projectRepo }: RunCompletionReportingDeps,
): Promise<void> => {
  if (!completion) {
    return;
  }
  try {
    const distinctId =
      completion.triggeredByUserId ??
      (await projectRepo.load(completion.projectId))?.createdByUserId;
    if (!distinctId) {
      return;
    }
    analytics.capture(distinctId, AnalyticsEvents.PipelineRunCompleted, {
      project_id: completion.projectId,
      pipeline_run_id: completion.pipelineRunId,
      status: completion.status,
      trigger: completion.triggeredByUserId ? "user" : "system",
      duration_ms: completion.durationMs,
    });
  } catch {
    return;
  }
};

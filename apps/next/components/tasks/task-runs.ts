/**
 * Adapts a Task's runs to the run view's `StepThreadRun` shape so the Task
 * view can reuse the step page's transcript and logs panels.
 */
import type { TaskRunContract } from "@scarn/api/frontend-contracts";
import type { StepThreadRun } from "@/components/executions/step-thread-model";

/** `runs` oldest first, as `GET /api/tasks/:taskId/runs` returns them. */
export function taskThreadRuns(
  runs: readonly TaskRunContract[],
): StepThreadRun[] {
  let attempt = 0;
  return runs.map((run, index) => {
    attempt = run.reason === "retry" ? attempt + 1 : 1;
    return {
      taskRunId: run.id,
      previousTaskRunId: run.previousTaskRunId,
      status: run.status,
      createdAt: run.createdAt,
      messages: [],
      sessionRestored: run.sessionRestored,
      runNumber: index + 1,
      visitId: null,
      attemptNumber: attempt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      workBranch: run.workBranch,
    };
  });
}

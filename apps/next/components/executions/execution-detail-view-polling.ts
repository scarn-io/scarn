import type { PipelineExecutionContract } from "@scarn/api/frontend-contracts";

const PENDING_TASK_STATUSES = new Set(["pending", "queued", "running"]);

/**
 * True while any visit's latest Task is still non-terminal. Polling must not
 * stop the instant the run reports a terminal status: a visit's Task status
 * can lag the run status by one tick.
 */
export function hasPendingTaskSnapshots(
  execution: PipelineExecutionContract,
): boolean {
  return execution.visits.some((visit) => {
    const latest = visit.tasks.at(-1);
    return latest !== undefined && PENDING_TASK_STATUSES.has(latest.status);
  });
}

export function buildExecutionProgressSignature(
  execution: PipelineExecutionContract,
): string {
  return JSON.stringify({
    status: execution.status,
    visits: execution.visits.map((visit) => ({
      id: visit.id,
      status: visit.status,
      tasks: visit.tasks.map((task) => task.status),
    })),
    lanes: execution.lanes.map((lane) => lane.status),
  });
}

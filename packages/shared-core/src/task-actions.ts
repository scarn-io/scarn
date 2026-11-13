import { ActionError, unwrapAction } from "./lib/action-error";
import type { TaskActionClient } from "./lib/action-clients";
import type { AuthHeaders } from "./lib/api-result";
import type { TaskDetail, TaskRunDetail } from "./lib/task-api-types";

/**
 * The safe actions on a Task: retry it in place, or cancel it. A Task a
 * pipeline step owns is retried by rerunning that step instead, and cancelling
 * it cancels its whole pipeline run.
 */

type TaskActionOptions = {
  client: TaskActionClient;
  headers: AuthHeaders;
  taskId: string;
};

export async function loadTask(
  options: TaskActionOptions,
): Promise<TaskDetail> {
  const { client, headers, taskId } = options;
  const result = await client.tasks.getTask({ path: { taskId }, headers });
  if (result.error?.status === 404) {
    throw new ActionError("not_found", `Task ${taskId} not found.`);
  }
  return unwrapAction(`load Task ${taskId}`, result);
}

function latestRun(runs: readonly TaskRunDetail[]): TaskRunDetail | null {
  return runs.reduce<TaskRunDetail | null>(
    (latest, run) =>
      latest === null || run.number > latest.number ? run : latest,
    null,
  );
}

export type RetriedTask = {
  taskId: string;
  taskRunId: string | null;
  previousRunId: string | null;
};

/**
 * Retries a standalone Task, sending its latest run's id so a retry that
 * raced another one is rejected (409) instead of doubling up.
 */
export async function retryTask(
  options: TaskActionOptions,
): Promise<RetriedTask> {
  const { client, headers, taskId } = options;
  const task = await loadTask(options);
  if (task.pipelineRunId !== null) {
    const step = task.nodeId ?? "<step>";
    throw new ActionError(
      "rejected",
      `Task ${taskId} belongs to pipeline run ${task.pipelineRunId}; rerun its step instead: scarn runs rerun ${task.pipelineRunId} --step ${step}`,
    );
  }
  const runs = unwrapAction(
    `load the runs of Task ${taskId}`,
    await client.tasks.getTaskRuns({ path: { taskId }, headers }),
  );
  const previousRunId = latestRun(runs)?.id ?? null;
  const retried = unwrapAction(
    `retry Task ${taskId}`,
    await client.tasks.retryTask({
      path: { taskId },
      body: { expectedLatestRunId: previousRunId },
      headers,
    }),
  );
  return { ...retried, previousRunId };
}

export async function cancelTask(
  options: TaskActionOptions,
): Promise<{ taskId: string }> {
  const { client, headers, taskId } = options;
  return unwrapAction(
    `cancel Task ${taskId}`,
    await client.tasks.cancelTask({ path: { taskId }, headers }),
  );
}

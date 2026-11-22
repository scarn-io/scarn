/**
 * Browser fetchers for Tasks: one Task with its runs, starting a Task on a
 * work item, and retrying one.
 */
import type {
  TaskDetailContract,
  TaskSummaryContract,
} from "@scarn/core/tasks/task/contracts/task-summary-contracts";
import type { CreatedTaskContract } from "@scarn/core/tasks/task/contracts/task-contracts";
import type { TaskEnvironmentInput } from "@scarn/core/tasks/task/contracts/task-environment-selection-contracts";
import type {
  TaskRunContract,
  RetriedTaskContract,
} from "@scarn/api/frontend-contracts";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { unwrapTreatyResponse } from "@/app/_lib/scarn-treaty";

export type TaskSummary = TaskSummaryContract;
export type TaskDetail = TaskDetailContract;
export type TaskStatus = TaskSummary["status"];
export type StartTaskInput = {
  projectId: string;
  workItemId: string;
  environment?: TaskEnvironmentInput;
} & (
  | { stepDefinitionId: string; stepDefinitionVersion: number }
  | { prompt: string; repoWrite: boolean }
);

export async function fetchTask(taskId: string): Promise<TaskDetail> {
  const apiClient = getBrowserScarnApiClient();
  return await unwrapTreatyResponse(
    apiClient.api.tasks({ taskId: parseUuidV7(taskId) }).get(),
  );
}

/** A Task's runs, oldest first. */
export async function fetchTaskRuns(
  taskId: string,
): Promise<TaskRunContract[]> {
  const apiClient = getBrowserScarnApiClient();
  return await unwrapTreatyResponse(
    apiClient.api.tasks({ taskId: parseUuidV7(taskId) }).runs.get(),
  );
}

export async function startTask(
  input: StartTaskInput,
): Promise<CreatedTaskContract> {
  const apiClient = getBrowserScarnApiClient();
  const base = {
    projectId: parseUuidV7(input.projectId),
    workItemId: parseUuidV7(input.workItemId),
    ...(input.environment ? { environment: input.environment } : {}),
  };
  return await unwrapTreatyResponse(
    apiClient.api.tasks.post(
      "prompt" in input
        ? { ...base, prompt: input.prompt, repoWrite: input.repoWrite }
        : {
            ...base,
            stepDefinitionId: parseUuidV7(input.stepDefinitionId),
            stepDefinitionVersion: input.stepDefinitionVersion,
          },
    ),
  );
}

export async function retryTask(
  taskId: string,
  expectedLatestRunId: string | null,
): Promise<RetriedTaskContract> {
  return await unwrapTreatyResponse(
    getBrowserScarnApiClient()
      .api.tasks({ taskId: parseUuidV7(taskId) })
      .retry.post({
        expectedLatestRunId:
          expectedLatestRunId === null
            ? null
            : parseUuidV7(expectedLatestRunId),
      }),
  );
}

/** Not ended, and not waiting on a person: it will run without anyone acting. */
export const isTaskLive = (status: TaskStatus): boolean =>
  status === "waiting_for_concurrency_slot" ||
  status === "waiting_for_work" ||
  status === "queued" ||
  status === "running";

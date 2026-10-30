import { createTaskPlaneClient } from "@scarn/sdk";
import { loadTaskLogLines, type TaskLogsClient } from "@scarn/shared-core";
import { parseUuidV7 } from "../../../common/contracts/uuid-v7";
import type { TaskRunWorkerClient } from "../contracts/process-project-work-types";
import type { TaskRunWorkerContextContract } from "../contracts/task-run-contracts";
import { loadAuthenticatedSession } from "../../../auth/session/application/load-authenticated-session";

export type TaskPlaneWorkerClient = TaskRunWorkerClient;

type TaskPlaneClient = Pick<
  ReturnType<typeof createTaskPlaneClient>,
  "getTaskRun" | "getTaskLogArchive" | "readTaskLogs"
>;

/**
 * Adapts the plane client's log reads to `@scarn/shared-core`'s
 * {@link TaskLogsClient}. The plane client already sends the bearer token, so
 * the per-call `headers` that interface carries are ignored. The cast covers
 * the generated SDK typing nullable fields as `T | unknown` (see
 * `InvestigateExecutionClient`); the runtime shapes match.
 */
export function toTaskLogsClient(planeClient: TaskPlaneClient): TaskLogsClient {
  return {
    taskRuns: {
      getTaskLogArchive: ({ path }: { path: { taskRunId: string } }) =>
        planeClient.getTaskLogArchive({ taskRunId: path.taskRunId }),
      readTaskLogs: ({
        path,
        query,
      }: {
        path: { taskRunId: string };
        query: { from: number; limit: number };
      }) => planeClient.readTaskLogs({ taskRunId: path.taskRunId, ...query }),
    },
  } as unknown as TaskLogsClient;
}

/**
 * Reads another Task's log lines. `loadTaskLogLines` picks the archive or the
 * live feed from `completedAt`, which the worker context does not carry, so
 * the Task is fetched first.
 */
export function buildLoadTaskLogLines(
  planeClient: TaskPlaneClient,
): NonNullable<TaskRunWorkerClient["loadTaskLogLines"]> {
  const logsClient = toTaskLogsClient(planeClient);
  return async ({ taskRunId }) => {
    const task = await planeClient.getTaskRun({ taskRunId });
    const completedAt =
      typeof task.completedAt === "string" ? task.completedAt : null;
    return await loadTaskLogLines(
      logsClient,
      { Authorization: "" },
      { id: taskRunId, completedAt },
    );
  };
}

export async function createTaskPlaneWorkerClient(
  baseUrl: string,
): Promise<TaskPlaneWorkerClient> {
  const authenticated = await loadAuthenticatedSession(baseUrl);

  if (!authenticated) {
    throw new Error(`Not signed in to ${baseUrl}.`);
  }

  const planeClient = createTaskPlaneClient(baseUrl, {
    headers: { Authorization: `Bearer ${authenticated.profile.accessToken}` },
  });

  return {
    ...planeClient,
    userId: parseUuidV7(authenticated.session.user.id),
    claimTaskRuns: async (input) =>
      (await planeClient.claimTaskRuns(input)).map((claim) => ({
        ...claim,
        task: { ...claim.task, id: parseUuidV7(claim.task.id) },
      })),
    getTaskRunWorkerContext: async (input) =>
      (await planeClient.getTaskRunWorkerContext(
        input,
      )) as TaskRunWorkerContextContract,
    loadTaskLogLines: buildLoadTaskLogLines(planeClient),
  };
}

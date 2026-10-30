import { createClient } from "./generated/client";
import { TaskRuns } from "./generated/sdk.gen";
import type {
  GetApiTaskRunsByTaskRunIdLogsData,
  PostApiTaskRunsByTaskRunIdArtifactFailuresData,
  PostApiTaskRunsByTaskRunIdArtifactUploadUrlData,
  PostApiTaskRunsByTaskRunIdArtifactsData,
  PostApiTaskRunsByTaskRunIdCompletionsData,
  PostApiTaskRunsByTaskRunIdLogsData,
  PostApiTaskRunsByTaskRunIdSessionUploadUrlData,
  PostApiTaskRunsByTaskRunIdYieldsData,
  PostApiTaskRunsClaimsData,
} from "./generated/types.gen";

type TaskRunRef = { taskRunId: string };

type CompletionBody = PostApiTaskRunsByTaskRunIdCompletionsData["body"];

export type TaskPlaneClientOptions = {
  headers?: Record<string, string> | undefined;
};

function unwrap<T>(result: { data?: T; error?: unknown }): T {
  if (result.error) throw new Error(JSON.stringify(result.error));
  return result.data as T;
}

/**
 * Worker-facing client for the task-run plane (`/api/task-runs/...`): claiming,
 * heartbeating, context, logs (writing, and reading another task run's), artifacts,
 * completion and yielding. Headers given here
 * (typically the worker's bearer token) are sent with every request.
 */
export function createTaskPlaneClient(
  baseUrl: string,
  options?: TaskPlaneClientOptions,
): ReturnType<typeof buildTaskPlaneClient> {
  const client = createClient({ baseUrl, headers: options?.headers });
  return buildTaskPlaneClient(new TaskRuns({ client }));
}

const buildTaskPlaneClient = (taskRuns: TaskRuns) => {
  return {
    claimTaskRuns: async (input: PostApiTaskRunsClaimsData["body"]) =>
      unwrap(await taskRuns.claimTaskRuns({ body: input })),
    heartbeatTaskRun: async ({
      taskRunId,
      ...body
    }: TaskRunRef & { claimToken: string; leaseDurationSeconds: number }) => {
      unwrap(await taskRuns.heartbeatTaskRun({ path: { taskRunId }, body }));
    },
    getTaskRun: async ({ taskRunId }: TaskRunRef) =>
      unwrap(await taskRuns.getTaskRun({ path: { taskRunId } })),
    /** Not unwrapped: callers read `error.status` (e.g. a 402 read quota). */
    getTaskLogArchive: ({ taskRunId }: TaskRunRef) =>
      taskRuns.getTaskLogArchive({ path: { taskRunId } }),
    /** Not unwrapped: callers read `error.status`. */
    readTaskLogs: ({
      taskRunId,
      ...query
    }: TaskRunRef & GetApiTaskRunsByTaskRunIdLogsData["query"]) =>
      taskRuns.readTaskLogs({ path: { taskRunId }, query }),
    getTaskRunWorkerContext: async ({
      taskRunId,
      ...body
    }: TaskRunRef & { claimToken: string }) =>
      unwrap(
        await taskRuns.getTaskRunWorkerContext({ path: { taskRunId }, body }),
      ),
    completeTaskRun: async ({
      taskRunId,
      ...body
    }: TaskRunRef & Omit<CompletionBody, "status">) => {
      unwrap(
        await taskRuns.completeTaskRun({
          path: { taskRunId },
          body: { ...body, status: "succeeded" },
        }),
      );
    },
    failTaskRun: async ({
      taskRunId,
      ...body
    }: TaskRunRef &
      Omit<CompletionBody, "status" | "workBranch" | "createdFromBranch">) => {
      unwrap(
        await taskRuns.completeTaskRun({
          path: { taskRunId },
          body: { ...body, status: "failed" },
        }),
      );
    },
    yieldTaskRun: async ({
      taskRunId,
      ...body
    }: TaskRunRef & PostApiTaskRunsByTaskRunIdYieldsData["body"]) => {
      unwrap(await taskRuns.yieldTaskRun({ path: { taskRunId }, body }));
    },
    appendTaskLogs: async ({
      taskRunId,
      ...body
    }: TaskRunRef & PostApiTaskRunsByTaskRunIdLogsData["body"]) =>
      unwrap(await taskRuns.appendTaskLogs({ path: { taskRunId }, body })),
    createArtifactUploadUrl: async ({
      taskRunId,
      ...body
    }: TaskRunRef & PostApiTaskRunsByTaskRunIdArtifactUploadUrlData["body"]) =>
      unwrap(
        await taskRuns.createArtifactUploadUrl({ path: { taskRunId }, body }),
      ),
    createSessionUploadUrl: async ({
      taskRunId,
      ...body
    }: TaskRunRef & PostApiTaskRunsByTaskRunIdSessionUploadUrlData["body"]) =>
      unwrap(
        await taskRuns.createSessionUploadUrl({ path: { taskRunId }, body }),
      ),
    recordArtifact: async ({
      taskRunId,
      ...body
    }: TaskRunRef & PostApiTaskRunsByTaskRunIdArtifactsData["body"]) => {
      unwrap(await taskRuns.recordTaskArtifact({ path: { taskRunId }, body }));
    },
    recordArtifactFailure: async ({
      taskRunId,
      ...body
    }: TaskRunRef & PostApiTaskRunsByTaskRunIdArtifactFailuresData["body"]) => {
      unwrap(
        await taskRuns.recordTaskArtifactFailure({ path: { taskRunId }, body }),
      );
    },
    listTaskArtifacts: async ({ taskRunId }: TaskRunRef) =>
      unwrap(await taskRuns.listTaskArtifacts({ path: { taskRunId } })),
    getArtifactDownloadUrl: async ({
      taskRunId,
      artifactId,
    }: TaskRunRef & { artifactId: string }) =>
      unwrap(
        await taskRuns.getArtifactDownloadUrl({
          path: { taskRunId, artifactId },
        }),
      ),
  };
};

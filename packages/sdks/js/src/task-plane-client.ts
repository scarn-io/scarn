import { createApiClient } from "./create-api-client";
import { TaskRuns } from "./generated/sdk.gen";
import type {
  GetApiTaskRunsByTaskRunIdLogsData,
  PostApiTaskRunsByTaskRunIdArtifactBundlesByBundleIdFinalizeData,
  PostApiTaskRunsByTaskRunIdArtifactBundlesData,
  PostApiTaskRunsByTaskRunIdArtifactFailuresData,
  PostApiTaskRunsByTaskRunIdArtifactUploadUrlData,
  PostApiTaskRunsByTaskRunIdArtifactsData,
  PostApiTaskRunsByTaskRunIdBaseCommitData,
  PostApiTaskRunsByTaskRunIdCompletionsData,
  PostApiTaskRunsByTaskRunIdEnvironmentData,
  PostApiTaskRunsByTaskRunIdLogFeedTokenData,
  PostApiTaskRunsByTaskRunIdLogsData,
  PostApiTaskRunsByTaskRunIdManagedLaunchData,
  PostApiTaskRunsByTaskRunIdSessionUploadUrlData,
  PostApiTaskRunsByTaskRunIdWorkItemCreatesData,
  PostApiTaskRunsByTaskRunIdWorkItemUpsertsData,
  PostApiTaskRunsByTaskRunIdWorkItemSourceCursorData,
  PostApiTaskRunsByTaskRunIdYieldsData,
  PostApiTaskRunsClaimsData,
} from "./generated/types.gen";

type TaskRunRef = { taskRunId: string };

type CompletionBody = PostApiTaskRunsByTaskRunIdCompletionsData["body"];

export type TaskPlaneClientOptions = {
  headers?: Record<string, string> | undefined;
  /**
   * Headers resolved per request and set over {@link headers}, for values
   * that can change during the client's lifetime (e.g. a rotated token).
   */
  requestHeaders?:
    | (() => Promise<Record<string, string>> | Record<string, string>)
    | undefined;
  /** Sees every response before it is parsed; throwing fails the call. */
  onResponse?: ((response: Response) => Promise<void> | void) | undefined;
  /**
   * Replaces `fetch` for every request, e.g. one from `createAuthenticatedFetch`.
   * An error it throws (a failed token mint, a network error) fails the call
   * as is.
   */
  fetch?:
    | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
    | undefined;
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
  const client = createApiClient(baseUrl, {
    headers: options?.headers,
    fetch: options?.fetch,
  });
  const requestHeaders = options?.requestHeaders;
  if (requestHeaders) {
    client.interceptors.request.use(async (request) => {
      for (const [name, value] of Object.entries(await requestHeaders())) {
        request.headers.set(name, value);
      }
      return request;
    });
  }
  const onResponse = options?.onResponse;
  if (onResponse) {
    client.interceptors.response.use(async (response) => {
      await onResponse(response);
      return response;
    });
  }
  return buildTaskPlaneClient(new TaskRuns({ client }));
}

const buildTaskPlaneClient = (taskRuns: TaskRuns) => {
  return {
    claimTaskRuns: async (input: PostApiTaskRunsClaimsData["body"]) =>
      unwrap(await taskRuns.claimTaskRuns({ body: input })),
    heartbeatTaskRun: async ({
      taskRunId,
      ...body
    }: TaskRunRef & { claimToken: string; leaseDurationSeconds: number }) =>
      unwrap(await taskRuns.heartbeatTaskRun({ path: { taskRunId }, body })),
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
    /** Pins the run's commit (first report wins); returns the stored values. */
    reportTaskRunBaseCommit: async ({
      taskRunId,
      ...body
    }: TaskRunRef & PostApiTaskRunsByTaskRunIdBaseCommitData["body"]) =>
      unwrap(
        await taskRuns.reportTaskRunBaseCommit({ path: { taskRunId }, body }),
      ),
    /** Project secret values for a claimed run; values are never logged. */
    resolveTaskRunEnvironment: async ({
      taskRunId,
      ...body
    }: TaskRunRef & PostApiTaskRunsByTaskRunIdEnvironmentData["body"]) =>
      unwrap(
        await taskRuns.resolveTaskRunEnvironment({ path: { taskRunId }, body }),
      ),
    /**
     * Registers the run's managed launch: a relay URL and capability per
     * connection-auth MCP server. Not unwrapped: callers read the 409
     * `MANAGED_CONNECTION_NOT_READY` problem.
     */
    registerTaskRunManagedLaunch: ({
      taskRunId,
      ...body
    }: TaskRunRef & PostApiTaskRunsByTaskRunIdManagedLaunchData["body"]) =>
      taskRuns.registerTaskRunManagedLaunch({ path: { taskRunId }, body }),
    readTaskRunWorkItem: async ({
      taskRunId,
      ...body
    }: TaskRunRef & { claimToken: string; workItemId: string }) =>
      unwrap(await taskRuns.readTaskRunWorkItem({ path: { taskRunId }, body })),
    /**
     * A code step's import write (`work-item-upserts`). Not unwrapped: the
     * step bridge relays the API's status, `code` and `meta`.
     */
    upsertTaskRunWorkItems: ({
      taskRunId,
      ...body
    }: TaskRunRef & PostApiTaskRunsByTaskRunIdWorkItemUpsertsData["body"]) =>
      taskRuns.upsertTaskRunWorkItems({ path: { taskRunId }, body }),
    /** Not unwrapped: the step bridge relays the API's status and error. */
    createTaskRunWorkItem: ({
      taskRunId,
      ...body
    }: TaskRunRef & PostApiTaskRunsByTaskRunIdWorkItemCreatesData["body"]) =>
      taskRuns.createTaskRunWorkItem({ path: { taskRunId }, body }),
    /** Not unwrapped: the step bridge relays the API's status and error. */
    latestTaskRunSourceUpdate: ({
      taskRunId,
      ...body
    }: TaskRunRef &
      PostApiTaskRunsByTaskRunIdWorkItemSourceCursorData["body"]) =>
      taskRuns.latestTaskRunSourceUpdate({ path: { taskRunId }, body }),
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
    /** Opens a `pending` bundle; members then upload with its `bundleId`. */
    createArtifactBundle: async ({
      taskRunId,
      ...body
    }: TaskRunRef & PostApiTaskRunsByTaskRunIdArtifactBundlesData["body"]) =>
      unwrap(
        await taskRuns.createArtifactBundle({ path: { taskRunId }, body }),
      ),
    /** Marks the bundle `ready` once its recorded members match `manifest`. */
    finalizeArtifactBundle: async ({
      taskRunId,
      bundleId,
      ...body
    }: TaskRunRef & {
      bundleId: string;
    } & PostApiTaskRunsByTaskRunIdArtifactBundlesByBundleIdFinalizeData["body"]) =>
      unwrap(
        await taskRuns.finalizeArtifactBundle({
          path: { taskRunId, bundleId },
          body,
        }),
      ),
    listArtifactBundles: async ({ taskRunId }: TaskRunRef) =>
      unwrap(await taskRuns.listArtifactBundles({ path: { taskRunId } })),
    /** Not unwrapped: callers read `response.status` (404 = push unavailable). */
    issueWorkSignalToken: ({
      projectId,
      workerId,
    }: {
      projectId: string;
      workerId?: string | undefined;
    }) =>
      taskRuns.issueWorkSignalToken({
        path: { projectId },
        body: workerId === undefined ? {} : { workerId },
      }),
    /** Not unwrapped: callers read `response.status` (404 = live log feed unavailable). */
    issueLogFeedWriteToken: ({
      taskRunId,
      ...body
    }: TaskRunRef & PostApiTaskRunsByTaskRunIdLogFeedTokenData["body"]) =>
      taskRuns.issueLogFeedWriteToken({ path: { taskRunId }, body }),
    /** Not unwrapped: callers read `response.status` (404 = live log feed unavailable). */
    issueLogFeedReadToken: ({ taskRunId }: TaskRunRef) =>
      taskRuns.issueLogFeedReadToken({ path: { taskRunId } }),
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

import { createTaskPlaneClient } from "@scarn/sdk";
import { loadTaskLogLines, type TaskLogsClient } from "@scarn/shared-core";
import { parseUuidV7 } from "../../../common/contracts/uuid-v7";
import type { TaskRunWorkerClient } from "../contracts/process-project-work-types";
import type { TaskRunWorkerContextContract } from "../contracts/task-run-contracts";
import {
  ProjectUnavailableError,
  projectUnavailableStatus,
} from "../contracts/project-unavailable-error";
import { fetchAuthenticatedSession } from "../../../auth/session/application/fetch-authenticated-session";
import { WorkerAuthError } from "../../../auth/session/domain/worker-auth-error";
import {
  type AuthProfileReader,
  createAuthProfileReader,
} from "../../../auth/session/infra/auth-profile-reader";

export type TaskPlaneWorkerClient = TaskRunWorkerClient;

type TaskPlaneClient = Pick<
  ReturnType<typeof createTaskPlaneClient>,
  "getTaskRun" | "getTaskLogArchive" | "readTaskLogs"
>;

/**
 * Adapts the plane client's log reads to `@scarn/shared-core`'s
 * {@link TaskLogsClient}. The plane client already sends the bearer token, so
 * the per-call `headers` that interface carries are ignored.
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
  };
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

export type TaskPlaneWorkerClientOptions = {
  /**
   * The user this worker must act as. Every call fails with
   * `WorkerAuthError("user_changed")` once `auth.jsonc` holds a different
   * user for the base URL. Defaults to the user signed in at creation.
   */
  expectedUserId?: string | undefined;
  /** Overrides the cached `auth.jsonc` reader (tests). */
  readProfile?: AuthProfileReader | undefined;
  /** Resolves the user a token belongs to; defaults to the session endpoint. */
  resolveUserId?:
    | ((input: { baseUrl: string; accessToken: string }) => Promise<string>)
    | undefined;
};

async function resolveSessionUserId(input: {
  baseUrl: string;
  accessToken: string;
}): Promise<string> {
  return (await fetchAuthenticatedSession(input)).user.id;
}

function requireProfile(
  readProfile: AuthProfileReader,
  baseUrl: string,
  userId: string,
) {
  const profile = readProfile(baseUrl);
  if (!profile) {
    throw new WorkerAuthError(
      "auth_missing",
      `Not signed in to ${baseUrl}. Run \`scarn auth login\` to authenticate.`,
    );
  }
  if (profile.userId !== undefined && profile.userId !== userId) {
    throw new WorkerAuthError(
      "user_changed",
      `The user signed in to ${baseUrl} changed; this worker runs as ${userId}.`,
    );
  }
  return profile;
}

async function readErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.clone().json();
    return typeof body === "object" &&
      body !== null &&
      "code" in body &&
      typeof body.code === "string"
      ? body.code
      : undefined;
  } catch {
    return undefined;
  }
}

async function throwIfProjectUnavailable(response: Response, baseUrl: string) {
  if (response.status !== 403 && response.status !== 404) return;
  const status = projectUnavailableStatus(
    response.status,
    await readErrorCode(response),
  );
  if (status === null) return;
  throw new ProjectUnavailableError(
    status,
    status === 404
      ? `${baseUrl} no longer has this project (HTTP 404).`
      : `The worker's user may no longer work on this project at ${baseUrl} (HTTP 403).`,
  );
}

/**
 * The worker's API client. The bearer token is read from `auth.jsonc` for
 * every request (cached until the file changes), so a long-running worker
 * picks up a re-login or rotated token. Calls fail with a typed
 * {@link WorkerAuthError} when the profile is gone, belongs to another user,
 * or the server answers 401/403.
 */
export async function createTaskPlaneWorkerClient(
  baseUrl: string,
  options: TaskPlaneWorkerClientOptions = {},
): Promise<TaskPlaneWorkerClient> {
  const readProfile = options.readProfile ?? createAuthProfileReader();
  const initialProfile = readProfile(baseUrl);
  if (!initialProfile) {
    throw new WorkerAuthError(
      "auth_missing",
      `Not signed in to ${baseUrl}. Run \`scarn auth login\` to authenticate.`,
    );
  }
  const signedInUserId = await (options.resolveUserId ?? resolveSessionUserId)({
    baseUrl,
    accessToken: initialProfile.accessToken,
  });
  const userId = options.expectedUserId ?? signedInUserId;
  if (signedInUserId !== userId) {
    throw new WorkerAuthError(
      "user_changed",
      `The user signed in to ${baseUrl} changed; this worker runs as ${userId}.`,
    );
  }

  const planeClient = createTaskPlaneClient(baseUrl, {
    requestHeaders: () => ({
      Authorization: `Bearer ${requireProfile(readProfile, baseUrl, userId).accessToken}`,
    }),
    onResponse: async (response) => {
      await throwIfProjectUnavailable(response, baseUrl);
      if (response.status === 401 || response.status === 403) {
        throw new WorkerAuthError(
          "auth_rejected",
          `${baseUrl} rejected the worker's credentials (HTTP ${String(response.status)}). Run \`scarn auth login\` to authenticate.`,
        );
      }
    },
  });

  return {
    ...planeClient,
    userId: parseUuidV7(userId),
    apiBaseUrl: baseUrl,
    claimTaskRuns: async (input) =>
      (await planeClient.claimTaskRuns(input)).map((claim) => ({
        ...claim,
        task: { ...claim.task, id: parseUuidV7(claim.task.id) },
      })),
    getTaskRunWorkerContext: async (input) =>
      (await planeClient.getTaskRunWorkerContext(
        input,
      )) as TaskRunWorkerContextContract,
    reportTaskRunBaseCommit: async (input) =>
      await planeClient.reportTaskRunBaseCommit(input),
    loadTaskLogLines: buildLoadTaskLogLines(planeClient),
    readTaskRunWorkItem: async (input) =>
      await planeClient.readTaskRunWorkItem(input),
    issueWorkSignalToken: async (input) => {
      const result = await planeClient.issueWorkSignalToken(input);
      if (result.response.status === 404) {
        return null;
      }
      if (result.error !== undefined) {
        throw new Error(
          `Work signal token request failed (HTTP ${String(result.response.status)})`,
        );
      }
      return result.data;
    },
    issueLogFeedWriteToken: async (input) => {
      const result = await planeClient.issueLogFeedWriteToken(input);
      if (result.response.status === 404 || result.response.status === 409) {
        return null;
      }
      if (result.error !== undefined) {
        throw new Error(
          `Log feed token request failed (HTTP ${String(result.response.status)})`,
        );
      }
      return result.data;
    },
  };
}

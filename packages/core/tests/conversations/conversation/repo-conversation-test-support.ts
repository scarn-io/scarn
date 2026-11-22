import type { ProjectRole } from "@/projects/project/domain/project-role";
/**
 * Shared setup for the repo conversation (chat) suites: a project, and calls
 * to create, answer, fail, reply to, retry, end and delete a chat, all through
 * the API. Actors are user IDs: the project owner, `ANONYMOUS_ACTOR_ID` (no
 * session), or a user made by `member`. Call inside a `describe`.
 */
import { asc, eq } from "drizzle-orm";
import { ANONYMOUS_ACTOR_ID } from "@/access/authorization/anonymous-actor";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { InMemoryObjectStore } from "@/artifacts/infra/in-memory-object-store";
import type { ObjectStore } from "@/artifacts/object-store";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { getDb } from "@/lib/db";
import { CoreError } from "@/lib/errors";
import { Result } from "@/lib/result";
import { taskRuns } from "@/lib/db/schema";
import { createHandOverHarness } from "tests/tasks/task/integration/hand-over-test-support";
import { unwrapAsync } from "tests/utils";

type EdenResponse<T> = {
  data: T | null;
  error: { status: unknown; value: unknown } | null;
};

/** An Eden response as a `Result`, its error as the `CoreError` the route threw. */
const resultOf = async <T>(
  response: Promise<EdenResponse<T>>,
): Promise<Result<T, CoreError>> => {
  const { data, error } = await response;
  if (!error) {
    return Result.ok(data as T);
  }
  const value = error.value as { code?: string; detail?: string };
  return Result.err(
    new CoreError({
      code: value.code ?? "UNKNOWN",
      message: value.detail ?? "",
      status: Number(error.status),
    }),
  );
};

export const FAILURE = {
  name: "Scarn.StepFailed",
  message: "the agent crashed",
};

export const SESSION_BYTES = 128;

/** Throws a failed result's error, so `statusOf` can read it. */
export const unwrap = async <T>(
  promise: Promise<Result<T, Error>>,
): Promise<T> => Result.unwrap(await promise);

/** An in-memory store that also presigns, recording every key it deletes. */
export class PresigningObjectStore extends InMemoryObjectStore {
  readonly deletedKeys: string[] = [];

  override async getPresignedGetUrl(key = ""): Promise<string | null> {
    return await Promise.resolve(`https://store.test/get/${key}`);
  }

  override async getPresignedPutUrl(key = ""): Promise<string | null> {
    return await Promise.resolve(`https://store.test/put/${key}`);
  }

  override async deleteObject(key: string): Promise<void> {
    this.deletedKeys.push(key);
    await super.deleteObject(key);
  }
}

export const createRepoConversationHarness = (
  options: { objectStore?: ObjectStore } = {},
) => {
  const h = createHandOverHarness(options);
  const sessions = new Map<UuidV7, { authorization: string }>();

  /** `actorId`'s session headers; none for `ANONYMOUS_ACTOR_ID`. */
  const headersFor = (
    actorId: UuidV7 = h.requireSetup().ownerId,
  ): { headers?: { authorization: string } } => {
    if (actorId === ANONYMOUS_ACTOR_ID) {
      return {};
    }
    const { ownerId, headers } = h.requireSetup();
    const found = actorId === ownerId ? headers : sessions.get(actorId);
    if (!found) {
      throw new Error(`No session for ${actorId}; make users with member()`);
    }
    return { headers: { ...found } };
  };

  /** Ends the chat as `actorId` (the project owner by default). */
  const end = async (conversationId: string, actorId?: UuidV7) =>
    await resultOf(
      h.apiClient.api
        .conversations({ conversationId })
        .end.post(undefined, headersFor(actorId)),
    );

  /** Deletes the chat as `actorId` (the project owner by default). */
  const remove = async (conversationId: string, actorId?: UuidV7) =>
    await resultOf(
      h.apiClient.api
        .conversations({ conversationId })
        .delete(undefined, headersFor(actorId)),
    );

  /**
   * Opens a chat through `POST /projects/:projectId/conversations`: its IDs
   * and the returned detail. Throws the route's error as a `CoreError`.
   */
  const create = async (
    body = "How does checkout work?",
    actorId?: UuidV7,
    projectId: UuidV7 = h.requireSetup().projectId,
  ) => {
    const detail = Result.unwrap(
      await resultOf(
        h.apiClient.api
          .projects({ projectId })
          .conversations.post({ body }, headersFor(actorId)),
      ),
    );
    if (!detail.taskId || !detail.latestRun) {
      throw new Error("Expected a chat with its Task and first run");
    }
    return {
      conversationId: detail.id,
      taskId: detail.taskId,
      taskRunId: detail.latestRun.id,
      detail,
    };
  };

  const created = async (body?: string, actorId?: UuidV7) =>
    await create(body, actorId);

  const statusOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof CoreError) {
        return { status: error.status, code: error.code };
      }
      throw error;
    }
    return { status: 200, code: null };
  };

  const claim = async (taskRunId: string) => {
    const { projectId, headers } = h.requireSetup();
    const claims = await unwrapAsync(
      h.apiClient.api["task-runs"].claims.post(
        {
          projectId,
          workerId: `chat-${crypto.randomUUID()}`,
          batchSize: 50,
          leaseDurationSeconds: 30,
        },
        { headers },
      ),
    );
    const claimToken = claims.find(
      (each) => each.task.id === taskRunId,
    )?.claimToken;
    if (!claimToken) {
      throw new Error("Expected to claim the chat's run");
    }
    return claimToken;
  };

  /** Claims the run, fetches its context as a worker does, and answers. */
  const answer = async (taskRunId: string, message: string) => {
    const claimToken = await claim(taskRunId);
    await h.workerContext(taskRunId, claimToken);
    await unwrapAsync(
      h.apiClient.api["task-runs"]({ taskRunId }).yields.post(
        { claimToken, message },
        { headers: h.requireSetup().headers },
      ),
    );
  };

  /** Claims the run and answers with an uploaded session; returns the claim and the session's key. */
  const answerWithSession = async (taskRunId: string, message: string) => {
    const claimToken = await claim(taskRunId);
    await h.workerContext(taskRunId, claimToken);
    const routes = h.apiClient.api["task-runs"]({ taskRunId });
    const { headers } = h.requireSetup();
    const upload = await unwrapAsync(
      routes["session-upload-url"].post(
        { claimToken, sizeBytes: SESSION_BYTES },
        { headers },
      ),
    );
    await unwrapAsync(
      routes.yields.post(
        {
          claimToken,
          message,
          sessionObjectKey: upload.objectKey,
          sessionSizeBytes: SESSION_BYTES,
        },
        { headers },
      ),
    );
    return { claimToken, sessionObjectKey: upload.objectKey };
  };

  /** Reports the run's base commit as a worker would; the raw API result. */
  const pinBaseCommit = async (
    taskRunId: string,
    claimToken: string,
    baseCommit: string,
    baseBranch?: string,
  ) =>
    await h.apiClient.api["task-runs"]({ taskRunId })["base-commit"].post(
      { claimToken, baseCommit, ...(baseBranch ? { baseBranch } : {}) },
      { headers: h.requireSetup().headers },
    );

  const fail = async (taskRunId: string) => {
    await h.completeRun(taskRunId, await claim(taskRunId), {
      status: "failed",
      errorJson: FAILURE,
    });
  };

  const runsOf = async (taskId: string) =>
    await getDb()
      .select()
      .from(taskRuns)
      .where(eq(taskRuns.taskId, taskId))
      .orderBy(asc(taskRuns.number));

  const reply = async (conversationId: UuidV7, body: string) => {
    const result = await h
      .conversationRoutes(conversationId)
      .messages.post({ body }, { headers: h.requireSetup().headers });
    return result.error
      ? {
          status: result.error.status,
          code: (result.error.value as { code?: string }).code,
        }
      : { status: 200, code: null };
  };

  const retry = async (taskId: string, expectedLatestRunId: string | null) => {
    const result = await h.apiClient.api.tasks({ taskId }).retry.post(
      {
        expectedLatestRunId:
          expectedLatestRunId === null
            ? null
            : parseUuidV7(expectedLatestRunId),
      },
      { headers: h.requireSetup().headers },
    );
    return result.error
      ? {
          status: result.error.status,
          code: (result.error.value as { code?: string }).code,
        }
      : { status: 200, code: null, value: result.data };
  };

  const conversationOf = async (conversationId: UuidV7) =>
    await unwrapAsync(
      h.conversationRoutes(conversationId).get({
        headers: h.requireSetup().headers,
      }),
    );

  const cancel = async (taskId: string) => {
    await unwrapAsync(
      h.apiClient.api
        .tasks({ taskId })
        .cancel.post(undefined, { headers: h.requireSetup().headers }),
    );
  };

  /** Sets a project member's role, adding them when they aren't one. */
  const setRole = async (userId: UuidV7, role: ProjectRole) => {
    const { projectId, headers } = h.requireSetup();
    await unwrapAsync(
      h.apiClient.api
        .projects({ projectId })
        .members({ userId })
        .role.put({ role }, { headers }),
    );
  };

  /** A new project member with `role`. */
  const member = async (role: ProjectRole) => {
    const user = await createTestUserAndSession({
      email: `chat-member-${crypto.randomUUID()}@example.com`,
    });
    const userId = parseUuidV7(user.userId);
    sessions.set(userId, user.authHeaders);
    await setRole(userId, role);
    return userId;
  };

  /** A signed-in user who isn't a project member. */
  const outsider = async () => {
    const user = await createTestUserAndSession({
      email: `chat-outsider-${crypto.randomUUID()}@example.com`,
    });
    const userId = parseUuidV7(user.userId);
    sessions.set(userId, user.authHeaders);
    return userId;
  };

  /** `GET /conversations/:id` as `actorId`; the raw Eden result. */
  const detailAs = async (conversationId: string, actorId?: UuidV7) =>
    await h.apiClient.api
      .conversations({ conversationId })
      .get(headersFor(actorId));

  /** `GET /projects/:projectId/conversations` as `actorId`; the raw Eden result. */
  const listAs = async (
    query: { before?: UuidV7; limit?: number } = {},
    actorId?: UuidV7,
    projectId: UuidV7 = h.requireSetup().projectId,
  ) =>
    await h.apiClient.api
      .projects({ projectId })
      .conversations.get({ query, ...headersFor(actorId) });

  /** `POST /conversations/:id/retry` as `actorId`; the raw Eden result. */
  const retryChat = async (
    conversationId: string,
    expectedLatestRunId: string | null,
    actorId?: UuidV7,
  ) =>
    await h.apiClient.api.conversations({ conversationId }).retry.post(
      {
        expectedLatestRunId:
          expectedLatestRunId === null
            ? null
            : parseUuidV7(expectedLatestRunId),
      },
      headersFor(actorId),
    );

  /** The session bytes daily reconciliation would count for the project's org. */
  const retainedSessionBytes = async () => {
    const org = await h.appContext.orgRepo.findByProjectId(
      h.requireSetup().projectId,
    );
    if (!org) {
      throw new Error("Expected the project to have an org");
    }
    const breakdown =
      await h.appContext.storageUsageReader.getRetainedBytesBreakdownForOrg(
        org.id,
        h.appContext.timeProvider.now(),
        30,
      );
    return breakdown.sessionBytes;
  };

  return {
    h,
    end,
    retainedSessionBytes,
    remove,
    member,
    outsider,
    headersFor,
    detailAs,
    listAs,
    retryChat,
    setRole,
    create,
    created,
    statusOf,
    claim,
    answer,
    answerWithSession,
    pinBaseCommit,
    fail,
    cancel,
    runsOf,
    reply,
    retry,
    conversationOf,
  };
};

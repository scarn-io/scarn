/**
 * DB-backed coverage for ending repo conversations (chats), and for how a
 * chat's Task ending on its own treats its conversation and sessions. In
 * neither `unit/` (it hits Postgres) nor `integration/` (they also read
 * the database directly; route-level tests are in `integration/`).
 */
import { describe, expect } from "bun:test";
import { and, eq } from "drizzle-orm";
import { ANONYMOUS_ACTOR_ID } from "@/access/authorization/anonymous-actor";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { projectMemberships } from "@/lib/db/schema";
import { serialTest } from "tests/utils";
import {
  createRepoConversationHarness,
  FAILURE,
  PresigningObjectStore,
  SESSION_BYTES,
  unwrap,
} from "./repo-conversation-test-support";

describe("repo conversations: ending", () => {
  const objectStore = new PresigningObjectStore();
  const {
    h,
    end,
    remove,
    member,
    created,
    statusOf,
    claim,
    answerWithSession,
    fail,
    runsOf,
    reply,
    retry,
    conversationOf,
    retainedSessionBytes,
  } = createRepoConversationHarness({ objectStore });

  const ended = async (conversationId: string) => {
    await unwrap(end(conversationId));
  };

  serialTest(
    "from queued: closes the conversation and cancels the Task and its run, writing no message",
    async () => {
      const chat = await created("What does the API do?");
      const conversationId = parseUuidV7(chat.conversationId);

      await ended(conversationId);

      const conversation = await conversationOf(conversationId);
      expect(conversation.status).toBe("closed");
      expect(conversation.messages.map((each) => each.authorKind)).toEqual([
        "person",
      ]);
      expect((await h.loadTask(parseUuidV7(chat.taskId)))?.status).toBe(
        "cancelled",
      );
      expect((await runsOf(chat.taskId)).map((run) => run.status)).toEqual([
        "cancelled",
      ]);
    },
  );

  serialTest(
    "from running: cancels the run and revokes its claim",
    async () => {
      const chat = await created();
      const claimToken = await claim(chat.taskRunId);

      await ended(chat.conversationId);

      const [run] = await runsOf(chat.taskId);
      expect(run?.status).toBe("cancelled");
      expect(run?.claimToken ?? null).toBeNull();
      const heartbeat = await h.apiClient.api["task-runs"]({
        taskRunId: chat.taskRunId,
      }).heartbeat.put(
        { claimToken, leaseDurationSeconds: 30 },
        { headers: h.requireSetup().headers },
      );
      expect(heartbeat.error?.status).toBe(409);
      expect((await h.loadTask(parseUuidV7(chat.taskId)))?.status).toBe(
        "cancelled",
      );
    },
  );

  serialTest(
    "from waiting: deletes the saved session after commit, clears its columns, and keeps the transcript",
    async () => {
      const chat = await created("Where is auth handled?");
      const conversationId = parseUuidV7(chat.conversationId);
      const { sessionObjectKey } = await answerWithSession(
        chat.taskRunId,
        "In middleware.",
      );
      const bytesBefore = await retainedSessionBytes();

      await ended(conversationId);

      expect(objectStore.deletedKeys).toContain(sessionObjectKey);
      const [run] = await runsOf(chat.taskId);
      expect(run?.sessionObjectKey ?? null).toBeNull();
      expect(run?.sessionSizeBytes ?? null).toBeNull();
      expect(bytesBefore - (await retainedSessionBytes())).toBe(SESSION_BYTES);
      const conversation = await conversationOf(conversationId);
      expect(conversation.status).toBe("closed");
      expect(
        conversation.messages.map(({ authorKind, body }) => ({
          authorKind,
          body,
        })),
      ).toEqual([
        { authorKind: "person", body: "Where is auth handled?" },
        { authorKind: "agent", body: "In middleware." },
      ]);
      expect((await h.loadTask(parseUuidV7(chat.taskId)))?.status).toBe(
        "cancelled",
      );
    },
  );

  serialTest(
    "from failed: closes the conversation and the Task stays failed",
    async () => {
      const chat = await created();
      await fail(chat.taskRunId);

      await ended(chat.conversationId);

      expect(
        (await conversationOf(parseUuidV7(chat.conversationId))).status,
      ).toBe("closed");
      expect((await h.loadTask(parseUuidV7(chat.taskId)))?.status).toBe(
        "failed",
      );
    },
  );

  serialTest("ending an ended chat does nothing", async () => {
    const chat = await created();
    const conversationId = parseUuidV7(chat.conversationId);
    await ended(conversationId);
    const before = await conversationOf(conversationId);
    const runsBefore = await runsOf(chat.taskId);

    await ended(conversationId);

    expect(await conversationOf(conversationId)).toEqual(before);
    expect(await runsOf(chat.taskId)).toEqual(runsBefore);
  });

  serialTest("an ended chat can't be retried or replied to", async () => {
    const chat = await created();
    const conversationId = parseUuidV7(chat.conversationId);
    await fail(chat.taskRunId);
    await ended(conversationId);

    expect(await retry(chat.taskId, chat.taskRunId)).toEqual({
      status: 409,
      code: "CONVERSATION_ENDED",
    });
    expect((await reply(conversationId, "Still there?")).status).toBe(409);
    expect(await runsOf(chat.taskId)).toHaveLength(1);
    expect((await conversationOf(conversationId)).status).toBe("closed");
  });

  serialTest(
    "is refused with 404 for a conversation that isn't a chat",
    async () => {
      const grilling = await h.handedOver("conversation");

      expect(await statusOf(unwrap(end(grilling.conversationId)))).toEqual({
        status: 404,
        code: "CONVERSATION_NOT_FOUND",
      });
      expect(await statusOf(unwrap(remove(grilling.conversationId)))).toEqual({
        status: 404,
        code: "CONVERSATION_NOT_FOUND",
      });
      expect((await h.loadTask(grilling.taskId))?.status).toBe(
        "waiting_for_person",
      );
    },
  );

  describe("permissions", () => {
    serialTest(
      "the creator and a manager may end it",
      async () => {
        const creator = await member("write");
        const own = await created(undefined, creator);
        const managed = await created(undefined, creator);

        expect((await end(own.conversationId, creator)).ok).toBe(true);
        expect((await end(managed.conversationId)).ok).toBe(true);
      },
    );

    serialTest(
      "a reader and a removed creator get 403; no session gets 401",
      async () => {
        const creator = await member("write");
        const chat = await created(undefined, creator);
        const reader = await member("read");

        expect(
          await statusOf(unwrap(end(chat.conversationId, reader))),
        ).toEqual({ status: 403, code: "PROJECT_FORBIDDEN" });
        expect(
          await statusOf(unwrap(remove(chat.conversationId, reader))),
        ).toEqual({ status: 403, code: "PROJECT_FORBIDDEN" });
        expect(
          await statusOf(unwrap(end(chat.conversationId, ANONYMOUS_ACTOR_ID))),
        ).toEqual({ status: 401, code: "UNAUTHORIZED" });

        await getDb()
          .delete(projectMemberships)
          .where(
            and(
              eq(projectMemberships.projectId, h.requireSetup().projectId),
              eq(projectMemberships.userId, creator),
            ),
          );
        expect(
          await statusOf(unwrap(end(chat.conversationId, creator))),
        ).toEqual({ status: 403, code: "PROJECT_FORBIDDEN" });
        expect(
          (await conversationOf(parseUuidV7(chat.conversationId))).status,
        ).toBe("reply_pending");
      },
    );
  });
});

describe("repo conversations: a chat's Task ending on its own", () => {
  const objectStore = new PresigningObjectStore();
  const {
    h,
    created,
    claim,
    answerWithSession,
    runsOf,
    reply,
    retry,
    conversationOf,
    retainedSessionBytes,
  } = createRepoConversationHarness({ objectStore });

  serialTest(
    "a final failure keeps the conversation open and retryable, and its sessions are deleted",
    async () => {
      const chat = await created();
      const conversationId = parseUuidV7(chat.conversationId);
      const { sessionObjectKey } = await answerWithSession(
        chat.taskRunId,
        "First answer.",
      );
      await reply(conversationId, "Follow-up?");
      const continuationId = (await runsOf(chat.taskId))[1]?.id ?? "";
      const bytesBefore = await retainedSessionBytes();
      await h.completeRun(continuationId, await claim(continuationId), {
        status: "failed",
        errorJson: FAILURE,
      });

      expect((await h.loadTask(parseUuidV7(chat.taskId)))?.status).toBe(
        "failed",
      );
      expect((await conversationOf(conversationId)).status).not.toBe("closed");
      expect(objectStore.deletedKeys).toContain(sessionObjectKey);
      expect(
        (await runsOf(chat.taskId)).map((run) => run.sessionObjectKey ?? null),
      ).toEqual([null, null]);
      expect(bytesBefore - (await retainedSessionBytes())).toBe(SESSION_BYTES);
      expect((await retry(chat.taskId, continuationId)).status).toBe(200);
    },
  );
});

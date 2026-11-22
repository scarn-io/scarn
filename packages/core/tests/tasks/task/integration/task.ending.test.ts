import { describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { conversations, taskRuns, workItemComments } from "@/lib/db/schema";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { concurrentTest, unwrapAsync } from "tests/utils";
import {
  createHandOverHarness,
  trackingObjectStore,
} from "./hand-over-test-support";

const failure = { name: "AgentCrashed", message: "The agent crashed." };

/**
 * A standalone Task's conversation closes, and its runs' saved sessions are
 * deleted, when the Task ends: Done, success, or a failure with no retries
 * left. Only a `continuation` restores the previous run's session.
 */
describe("ending a Task", () => {
  const objectStore = trackingObjectStore();
  const {
    requireSetup,
    seedItem,
    claim,
    startTask,
    yieldWithSession,
    completeRun,
    workerContext,
    loadTask,
    messagesOf,
    conversationRoutes,
    handedOver,
    yieldRun,
  } = createHandOverHarness({ objectStore: objectStore.store });

  const commentsOf = async (workItemId: UuidV7) =>
    await getDb()
      .select({
        authorKind: workItemComments.authorKind,
        authoredByTaskId: workItemComments.authoredByTaskId,
        body: workItemComments.body,
      })
      .from(workItemComments)
      .where(eq(workItemComments.workItemId, workItemId));

  const latestRunOf = async (taskId: UuidV7) => {
    const run = (
      await getDb().select().from(taskRuns).where(eq(taskRuns.taskId, taskId))
    )
      .sort((left, right) => left.number - right.number)
      .at(-1);
    if (!run) {
      throw new Error("Expected a run");
    }
    return run;
  };

  const conversationStatusOf = async (conversationId: string) =>
    (
      await getDb()
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId))
    )[0]?.status;

  /** A standalone Task whose first run handed over with a saved session. */
  const handedOverWithSession = async (
    kind: "findings" | "conversation" | "retrying",
  ) => {
    const workItemId = await seedItem();
    const { taskId, taskRunId } = await startTask(workItemId, kind);
    const sessionKey = await yieldWithSession(
      workItemId,
      taskRunId,
      "v1 or v2?",
    );
    const conversationId = (await loadTask(taskId))?.conversationId;
    if (!conversationId) {
      throw new Error("Expected the Task's conversation");
    }
    return {
      workItemId,
      taskId,
      sessionKey,
      conversationId: parseUuidV7(conversationId),
    };
  };

  const reply = async (conversationId: UuidV7, body: string) =>
    await unwrapAsync(
      conversationRoutes(conversationId).messages.post(
        { body },
        { headers: requireSetup().headers },
      ),
    );

  const claimLatest = async (workItemId: UuidV7, taskId: UuidV7) => {
    const run = await latestRunOf(taskId);
    return { run, claimToken: await claim(workItemId, run.id) };
  };

  concurrentTest(
    "Done closes the conversation and deletes the Task's saved sessions",
    async () => {
      const { taskId, sessionKey, conversationId } =
        await handedOverWithSession("conversation");
      expect(objectStore.deletedKeys).not.toContain(sessionKey);

      const ended = await unwrapAsync(
        conversationRoutes(conversationId).done.post(undefined, {
          headers: requireSetup().headers,
        }),
      );

      expect(ended.status).toBe("closed");
      expect((await loadTask(taskId))?.status).toBe("succeeded");
      expect(await conversationStatusOf(conversationId)).toBe("closed");
      expect(objectStore.deletedKeys).toContain(sessionKey);
    },
  );

  concurrentTest(
    "a continuation after a reply restores the session, and its success closes the conversation",
    async () => {
      const { workItemId, taskId, sessionKey, conversationId } =
        await handedOverWithSession("findings");
      await reply(conversationId, "v2, please.");
      const { run, claimToken } = await claimLatest(workItemId, taskId);
      expect(run.reason).toBe("continuation");

      const context = await workerContext(run.id, claimToken);
      expect(context.restoreSession?.downloadUrl).toBe(
        `https://store.test/get/${sessionKey}`,
      );
      expect(await conversationStatusOf(conversationId)).not.toBe("closed");

      await completeRun(run.id, claimToken, {
        status: "succeeded",
        resultJson: { fix: "v2" },
      });

      expect(await loadTask(taskId)).toMatchObject({
        status: "succeeded",
        resultJson: { fix: "v2" },
      });
      expect(await conversationStatusOf(conversationId)).toBe("closed");
      expect(objectStore.deletedKeys).toContain(sessionKey);
    },
  );

  concurrentTest(
    "a retry starts a fresh session, and a failure with no retries left closes the conversation",
    async () => {
      const { workItemId, taskId, sessionKey, conversationId } =
        await handedOverWithSession("retrying");
      await reply(conversationId, "v2, please.");
      const continuation = await claimLatest(workItemId, taskId);
      await completeRun(continuation.run.id, continuation.claimToken, {
        status: "failed",
        errorJson: failure,
      });
      expect(await conversationStatusOf(conversationId)).not.toBe("closed");
      expect(objectStore.deletedKeys).not.toContain(sessionKey);

      const retry = await claimLatest(workItemId, taskId);
      expect(retry.run.reason).toBe("retry");
      const context = await workerContext(retry.run.id, retry.claimToken);
      expect(context.restoreSession).toBeNull();
      expect(context.previousRun).toBeNull();

      await completeRun(retry.run.id, retry.claimToken, {
        status: "failed",
        errorJson: failure,
      });

      expect((await loadTask(taskId))?.status).toBe("failed");
      expect(await conversationStatusOf(conversationId)).toBe("closed");
      expect(objectStore.deletedKeys).toContain(sessionKey);
    },
  );

  concurrentTest(
    "a Task with no result schema that succeeds without handing over stores { conversationId, summary } and posts the summary",
    async () => {
      const workItemId = await seedItem();
      const { taskId, taskRunId } = await startTask(workItemId, "conversation");
      const claimToken = await claim(workItemId, taskRunId);

      await completeRun(taskRunId, claimToken, {
        status: "succeeded",
        resultJson: { summary: "  Shipped v2 behind a flag.  " },
      });

      const task = await loadTask(taskId);
      const conversationId = task?.conversationId;
      if (!conversationId) {
        throw new Error("Expected the Task's conversation");
      }
      expect(task).toMatchObject({
        status: "succeeded",
        resultJson: { conversationId, summary: "Shipped v2 behind a flag." },
      });
      expect((await latestRunOf(taskId)).resultJson).toEqual({
        conversationId,
        summary: "Shipped v2 behind a flag.",
      });
      expect(
        (await messagesOf(conversationId)).map((each) => [
          each.authorKind,
          each.body,
        ]),
      ).toEqual([["agent", "Shipped v2 behind a flag."]]);
      expect(await conversationStatusOf(conversationId)).toBe("closed");
      expect(await commentsOf(workItemId)).toEqual([]);
    },
  );

  concurrentTest(
    "Done after talking to a person posts one summary comment, authored by the Task, with its branch",
    async () => {
      const { workItemId, taskId, conversationId } =
        await handedOver("conversation");
      await reply(conversationId, "v2, please.");
      const continuation = await latestRunOf(taskId);
      await yieldRun(workItemId, continuation.id, {
        message: "Decided on v2 with you; the fix is on the branch.",
        workBranch: "scarn/summary-1",
      });

      await unwrapAsync(
        conversationRoutes(conversationId).done.post(undefined, {
          headers: requireSetup().headers,
        }),
      );

      expect(await commentsOf(workItemId)).toEqual([
        {
          authorKind: "agent",
          authoredByTaskId: taskId,
          body: "Decided on v2 with you; the fix is on the branch.\n\nBranch: `scarn/summary-1`",
        },
      ]);
    },
  );

  concurrentTest(
    "Done without a person ever replying posts no summary comment",
    async () => {
      const { workItemId, conversationId } = await handedOver("conversation");

      await unwrapAsync(
        conversationRoutes(conversationId).done.post(undefined, {
          headers: requireSetup().headers,
        }),
      );

      expect(await conversationStatusOf(conversationId)).toBe("closed");
      expect(await commentsOf(workItemId)).toEqual([]);
    },
  );
});

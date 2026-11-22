import { describe, expect } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  conversations,
  taskRuns,
  userNotifications,
  workItems,
} from "@/lib/db/schema";
import { getDb } from "@/lib/db";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { createHandOverHarness } from "./hand-over-test-support";

/**
 * A standalone Task whose agent hands over owns the conversation: the yield
 * opens it on the Task, posts the agent's message from the run, and tells
 * the people involved that Scarn waits on them. A later hand-over reuses it.
 */
describe("handing over", () => {
  const {
    requireSetup,
    seedItem,
    yieldRun,
    startTask,
    loadTask,
    messagesOf,
    conversationRoutes,
    taskView,
  } = createHandOverHarness();

  const waitingOnIds = async (taskId: UuidV7) =>
    (await taskView(taskId)).waitingOn.map((each) => each.userId);

  concurrentTest(
    "opens the Task's conversation, posts the message and notifies",
    async () => {
      const workItemId = await seedItem();
      const { taskId, taskRunId } = await startTask(workItemId);

      const run = await yieldRun(workItemId, taskRunId, {
        message: "  v1 or v2?\n",
      });

      expect(run.status).toBe("yielded");
      const task = await loadTask(taskId);
      expect(task?.status).toBe("waiting_for_person");
      const conversationId = task?.conversationId;
      if (!conversationId) {
        throw new Error("Expected the Task's conversation");
      }
      const [conversation] = await getDb()
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      expect(conversation).toMatchObject({
        workItemId,
        status: "waiting_for_person",
      });
      expect(await taskView(taskId)).toMatchObject({
        waitingOnYou: true,
        waitingOn: [{ userId: requireSetup().ownerId }],
      });
      expect(await messagesOf(conversationId)).toMatchObject([
        { authorKind: "agent", taskRunId, body: "v1 or v2?" },
      ]);
      const notifications = await getDb()
        .select()
        .from(userNotifications)
        .where(
          and(
            eq(userNotifications.taskId, taskId),
            eq(userNotifications.kind, "feedback_request"),
          ),
        );
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        workItemId,
        pipelineExecutionId: null,
        body: "v1 or v2?",
        recipientUserId: requireSetup().ownerId,
        payloadJson: { conversationId },
      });
    },
  );

  concurrentTest(
    "a second hand-over after a continuation reuses the conversation",
    async () => {
      const workItemId = await seedItem();
      const { taskId, taskRunId } = await startTask(workItemId);
      await yieldRun(workItemId, taskRunId, {
        message: "First?",
      });
      const conversationId = parseUuidV7(
        (await loadTask(taskId))?.conversationId ?? "",
      );

      await unwrapAsync(
        conversationRoutes(conversationId).messages.post(
          { body: "v2." },
          { headers: requireSetup().headers },
        ),
      );
      expect(
        await getDb()
          .select()
          .from(conversations)
          .where(eq(conversations.id, conversationId)),
      ).toMatchObject([{ status: "reply_pending" }]);
      expect(await taskView(taskId)).toMatchObject({
        waitingOnYou: false,
        waitingOn: [],
      });
      const continuationId = (
        await getDb()
          .select()
          .from(taskRuns)
          .where(and(eq(taskRuns.taskId, taskId), eq(taskRuns.number, 2)))
      )[0]?.id;
      if (!continuationId) {
        throw new Error("Expected the continuation run");
      }
      await yieldRun(workItemId, continuationId, {
        message: "Second?",
      });

      const task = await loadTask(taskId);
      expect(task?.status).toBe("waiting_for_person");
      expect(task?.conversationId).toBe(conversationId);
      const messages = await messagesOf(conversationId);
      expect(
        messages
          .filter((each) => each.authorKind === "agent")
          .map((each) => [each.body, each.taskRunId])
          .sort(),
      ).toEqual([
        ["First?", taskRunId],
        ["Second?", continuationId],
      ]);
      expect(
        await getDb()
          .select()
          .from(conversations)
          .where(eq(conversations.workItemId, workItemId)),
      ).toMatchObject([{ status: "waiting_for_person" }]);
      expect(await waitingOnIds(taskId)).toEqual([requireSetup().ownerId]);
    },
  );

  concurrentTest(
    "waits on the assignee first, then the creator and the starter",
    async () => {
      const assignee = await createTestUserAndSession({
        email: `hand-over-assignee-${crypto.randomUUID()}@example.com`,
      });
      const creator = await createTestUserAndSession({
        email: `hand-over-creator-${crypto.randomUUID()}@example.com`,
      });
      const assigneeId = parseUuidV7(assignee.userId);
      const creatorId = parseUuidV7(creator.userId);
      const workItemId = await seedItem({
        createdByUserId: creatorId,
        assigneeUserId: assigneeId,
      });
      const { taskId, taskRunId } = await startTask(workItemId);

      await yieldRun(workItemId, taskRunId, {
        message: "Which one?",
      });

      expect(await waitingOnIds(taskId)).toEqual([
        assigneeId,
        creatorId,
        requireSetup().ownerId,
      ]);
      const notified = await getDb()
        .select({ recipientUserId: userNotifications.recipientUserId })
        .from(userNotifications)
        .where(
          and(
            eq(userNotifications.taskId, taskId),
            eq(userNotifications.kind, "feedback_request"),
          ),
        );
      expect(notified.map((each) => each.recipientUserId).sort()).toEqual(
        [assigneeId, creatorId, requireSetup().ownerId].sort(),
      );
    },
  );

  concurrentTest(
    "an assignee who is also the creator is waited on once",
    async () => {
      const { ownerId } = requireSetup();
      const workItemId = await seedItem({
        createdByUserId: ownerId,
        assigneeUserId: ownerId,
      });
      const { taskId, taskRunId } = await startTask(workItemId);

      await yieldRun(workItemId, taskRunId, {
        message: "Which one?",
      });

      expect(await waitingOnIds(taskId)).toEqual([ownerId]);
    },
  );

  concurrentTest(
    "waits on whoever the work item is assigned to now",
    async () => {
      const assignee = await createTestUserAndSession({
        email: `hand-over-reassigned-${crypto.randomUUID()}@example.com`,
      });
      const assigneeId = parseUuidV7(assignee.userId);
      const { ownerId } = requireSetup();
      const workItemId = await seedItem({ createdByUserId: ownerId });
      const { taskId, taskRunId } = await startTask(workItemId);
      await yieldRun(workItemId, taskRunId, {
        message: "Which one?",
      });

      await getDb()
        .update(workItems)
        .set({ assigneeUserId: assigneeId })
        .where(eq(workItems.id, workItemId));

      expect(await waitingOnIds(taskId)).toEqual([assigneeId, ownerId]);
    },
  );
});

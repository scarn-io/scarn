/**
 * DB-backed coverage for how repo conversations (chats) read in the Task
 * list, the Task view and the project inbox. In neither `unit/` (it hits
 * Postgres) nor `integration/` (they also read the database directly;
 * route-level tests are in `integration/`).
 */
import { describe, expect } from "bun:test";
import type { UuidV7 } from "@/common/contracts/uuid-v7";
import { serialTest, unwrapAsync } from "tests/utils";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";
import {
  createRepoConversationHarness,
  unwrap,
} from "./repo-conversation-test-support";

const ANSWER = "Checkout goes through the cart service.";

describe("repo conversations: Tasks and inbox", () => {
  const { h, created, member, headersFor, answer, fail, cancel, end, remove } =
    createRepoConversationHarness();

  const projectRoutes = () =>
    h.apiClient.api.projects({ projectId: h.requireSetup().projectId });

  const listTasks = async (
    query: Record<string, string | boolean | string[]> = {},
    actorId?: UuidV7,
  ) =>
    await unwrapAsync(
      projectRoutes().tasks.get({
        query: { limit: 200, ...query },
        ...headersFor(actorId),
      }),
    );

  const summaryOf = async (actorId?: UuidV7) =>
    await unwrapAsync(projectRoutes().inbox.summary.get(headersFor(actorId)));

  /** The inbox's waiting and failed lists, as the Inbox page reads them. */
  const inboxTaskIds = async (actorId?: UuidV7) => {
    const [waiting, failed] = await Promise.all([
      listTasks({ waitingOnMe: true, excludeEndedChats: true }, actorId),
      listTasks(
        { status: "failed", startedByMe: true, excludeEndedChats: true },
        actorId,
      ),
    ]);
    return {
      waiting: waiting.tasks.map((task) => task.id),
      failed: failed.tasks.map((task) => task.id),
    };
  };

  serialTest(
    "a chat Task reads with its chat and its first question as the title, and no work item",
    async () => {
      const chat = await created("  How does\n checkout   work?  ");

      const { tasks } = await listTasks();
      const row = tasks.find((task) => task.id === chat.taskId);
      expect(row).toMatchObject({
        workItem: null,
        conversationId: chat.conversationId,
        repoConversation: {
          id: chat.conversationId,
          title: "How does checkout work?",
        },
      });

      const detail = await unwrapAsync(
        h.apiClient.api.tasks({ taskId: chat.taskId }).get(headersFor()),
      );
      expect(detail.workItem).toBeNull();
      expect(detail.repoConversation).toEqual({
        id: chat.conversationId,
        title: "How does checkout work?",
      });

      await unwrap(end(chat.conversationId));
    },
  );

  serialTest("a work item's Task has no chat", async () => {
    const { projectId } = h.requireSetup();
    const workItemId = await seedWorkItem(projectId);
    const task = await unwrapAsync(
      h.apiClient.api.tasks.post(
        { projectId, workItemId, prompt: "Do it" },
        headersFor(),
      ),
    );

    const { tasks } = await listTasks({ workItemId });
    expect(tasks.map((each) => each.id)).toEqual([task.task.id]);
    expect(tasks[0]?.workItem?.id).toBe(workItemId);
    expect(tasks[0]?.repoConversation).toBeNull();

    await cancel(task.task.id);
  });

  serialTest(
    "chats stay separate rows, even when only each work item's newest Task is listed",
    async () => {
      const first = await created("First question");
      const second = await created("Second question");

      for (const latestPerWorkItem of [false, true]) {
        const { tasks } = await listTasks({ latestPerWorkItem });
        const chats = tasks.filter(
          (task) => task.id === first.taskId || task.id === second.taskId,
        );
        expect(chats.map((task) => task.repoConversation)).toEqual([
          { id: second.conversationId, title: "Second question" },
          { id: first.conversationId, title: "First question" },
        ]);
      }

      await unwrap(end(first.conversationId));
      await unwrap(end(second.conversationId));
    },
  );

  serialTest(
    "a waiting chat is in its creator's inbox only, and counts once",
    async () => {
      const other = await member("write");
      const ownerBefore = await summaryOf();
      const otherBefore = await summaryOf(other);
      const chat = await created();

      await answer(chat.taskRunId, ANSWER);

      expect((await inboxTaskIds()).waiting).toContain(chat.taskId);
      expect((await inboxTaskIds(other)).waiting).not.toContain(chat.taskId);
      const ownerAfter = await summaryOf();
      expect(ownerAfter.waitingOnMe).toBe(ownerBefore.waitingOnMe + 1);
      expect(ownerAfter.badgeCount).toBe(ownerBefore.badgeCount + 1);
      const otherAfter = await summaryOf(other);
      expect(otherAfter.badgeCount).toBe(otherBefore.badgeCount);
      expect(otherAfter.waitingOnOthers).toBe(otherBefore.waitingOnOthers + 1);

      await unwrap(end(chat.conversationId));
    },
  );

  serialTest("a failed chat counts for its creator", async () => {
    const before = await summaryOf();
    const chat = await created();

    await fail(chat.taskRunId);

    expect((await inboxTaskIds()).failed).toContain(chat.taskId);
    const after = await summaryOf();
    expect(after.failedStartedByMe).toBe(before.failedStartedByMe + 1);
    expect(after.badgeCount).toBe(before.badgeCount + 1);

    await unwrap(end(chat.conversationId));
  });

  serialTest(
    "an ended chat leaves the inbox, whether it ended failed or waiting",
    async () => {
      const before = await summaryOf();
      const failed = await created("Will fail");
      await fail(failed.taskRunId);
      const waiting = await created("Will wait");
      await answer(waiting.taskRunId, ANSWER);

      await unwrap(end(failed.conversationId));
      await unwrap(end(waiting.conversationId));

      const ids = await inboxTaskIds();
      expect(ids.failed).not.toContain(failed.taskId);
      expect(ids.waiting).not.toContain(waiting.taskId);
      expect(await summaryOf()).toEqual(before);
    },
  );

  serialTest("a deleted chat is gone from the inbox and Tasks", async () => {
    const before = await summaryOf();
    const failed = await created("Will fail");
    await fail(failed.taskRunId);
    const waiting = await created("Will wait");
    await answer(waiting.taskRunId, ANSWER);

    await unwrap(remove(failed.conversationId));
    await unwrap(remove(waiting.conversationId));

    const { tasks } = await listTasks();
    expect(tasks.map((task) => task.id)).not.toContain(failed.taskId);
    expect(tasks.map((task) => task.id)).not.toContain(waiting.taskId);
    expect(await summaryOf()).toEqual(before);
  });
});

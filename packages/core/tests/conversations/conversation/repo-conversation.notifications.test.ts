/**
 * DB-backed coverage for the notifications repo conversations (chats) send
 * their creator. In neither `unit/` (it hits Postgres) nor `integration/`
 * (they also read the
 * database directly; route-level tests are in `integration/`).
 */
import { describe, expect } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { notificationDeliveries, userNotifications } from "@/lib/db/schema";
import { NOT_APPLICABLE_WITHOUT_WORK_ITEM } from "@/notifications/user-notification/application/notify-repo-conversation";
import { serialTest, unwrapAsync } from "tests/utils";
import {
  createRepoConversationHarness,
  unwrap,
} from "./repo-conversation-test-support";

const ANSWER = "Checkout goes through the cart service, then payments.";

describe("repo conversations: notifications", () => {
  const {
    h,
    created,
    member,
    answer,
    fail,
    claim,
    end,
    remove,
    reply,
    runsOf,
  } = createRepoConversationHarness();

  const notificationsOf = async (taskId: string) =>
    await getDb()
      .select()
      .from(userNotifications)
      .where(eq(userNotifications.taskId, taskId));

  serialTest(
    "an answer tells only the creator, content-free, once",
    async () => {
      await member("write");
      const chat = await created("How does checkout work?");

      await answer(chat.taskRunId, ANSWER);

      const notified = await notificationsOf(chat.taskId);
      expect(notified).toHaveLength(1);
      expect(notified[0]).toMatchObject({
        kind: "result_ready",
        recipientUserId: h.requireSetup().ownerId,
        title: "Repo conversation answer ready",
        taskId: chat.taskId,
        workItemId: null,
        payloadJson: { conversationId: chat.conversationId },
      });
      expect(notified[0]?.title).not.toContain("checkout");
      expect(notified[0]?.body).not.toContain("cart service");
    },
  );

  serialTest("each answered turn notifies once", async () => {
    const chat = await created();
    const conversationId = parseUuidV7(chat.conversationId);
    await answer(chat.taskRunId, ANSWER);
    await reply(conversationId, "And refunds?");
    const continuationId = (await runsOf(chat.taskId))[1]?.id ?? "";

    await answer(continuationId, "Refunds go through payments.");

    const notified = await notificationsOf(chat.taskId);
    expect(notified.map((each) => each.kind)).toEqual([
      "result_ready",
      "result_ready",
    ]);
  });

  serialTest(
    "a repeated yield of the same run doesn't notify again",
    async () => {
      const chat = await created();
      const claimToken = await claim(chat.taskRunId);
      await h.workerContext(chat.taskRunId, claimToken);
      const yields = h.apiClient.api["task-runs"]({
        taskRunId: chat.taskRunId,
      }).yields;
      await unwrapAsync(
        yields.post(
          { claimToken, message: ANSWER },
          { headers: h.requireSetup().headers },
        ),
      );

      await yields.post(
        { claimToken, message: ANSWER },
        { headers: h.requireSetup().headers },
      );

      expect(await notificationsOf(chat.taskId)).toHaveLength(1);
    },
  );

  serialTest("a failed turn warns the creator, without the error", async () => {
    const chat = await created();

    await fail(chat.taskRunId);

    const notified = await notificationsOf(chat.taskId);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({
      kind: "warning",
      recipientUserId: h.requireSetup().ownerId,
      title: "Repo conversation failed",
      workItemId: null,
      payloadJson: { conversationId: chat.conversationId },
    });
    expect(notified[0]?.body).not.toContain("crashed");
  });

  serialTest("ending a chat notifies nobody", async () => {
    const queued = await created();
    const waiting = await created();
    await answer(waiting.taskRunId, ANSWER);
    const before = (await notificationsOf(waiting.taskId)).length;

    await unwrap(end(queued.conversationId));
    await unwrap(end(waiting.conversationId));

    expect(await notificationsOf(queued.taskId)).toEqual([]);
    expect(await notificationsOf(waiting.taskId)).toHaveLength(before);
  });

  serialTest("deleting a running chat notifies nobody", async () => {
    const chat = await created();
    await claim(chat.taskRunId);

    await unwrap(remove(chat.conversationId));

    expect(await notificationsOf(chat.taskId)).toEqual([]);
  });

  serialTest(
    "never delivers a work item platform comment, even when a rule enables it",
    async () => {
      const { projectId, headers } = h.requireSetup();
      await unwrapAsync(
        h.apiClient.api.projects({ projectId })["notification-rules"].put(
          {
            kind: "result_ready",
            channel: "work_item_platform_comment",
            enabled: true,
            minPriority: null,
            conditionsJson: null,
          },
          { headers },
        ),
      );
      const chat = await created();

      await answer(chat.taskRunId, ANSWER);

      const ids = (await notificationsOf(chat.taskId)).map(
        (each) => each.id as UuidV7,
      );
      const deliveries = await getDb()
        .select()
        .from(notificationDeliveries)
        .where(inArray(notificationDeliveries.notificationId, ids));
      expect(
        deliveries.find(
          (each) => each.channel === "work_item_platform_comment",
        ),
      ).toMatchObject({
        status: "suppressed",
        suppressionReason: NOT_APPLICABLE_WITHOUT_WORK_ITEM,
      });
    },
  );
});

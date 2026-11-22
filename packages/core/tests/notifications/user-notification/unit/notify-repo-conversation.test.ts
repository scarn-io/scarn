import { describe, expect } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import type { DbExecutor } from "@/lib/db/db-executor";
import type { NotificationDeliveryEntity } from "@/notifications/notification-delivery/domain/notification-delivery-entity";
import { NotificationRuleEntity } from "@/notifications/notification-policy/domain/notification-rule-entity";
import type { NotificationChannel } from "@/notifications/notification-delivery/contracts/notification-delivery-contracts";
import {
  NOT_APPLICABLE_WITHOUT_WORK_ITEM,
  notifyRepoConversation,
  type NotifyRepoConversationDeps,
} from "@/notifications/user-notification/application/notify-repo-conversation";
import type { UserNotificationEntity } from "@/notifications/user-notification/domain/user-notification-entity";
import { concurrentTest } from "tests/utils";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const tx = {} as DbExecutor;

const fakeDeps = (rules: NotificationRuleEntity[] = []) => {
  const created: UserNotificationEntity[] = [];
  const deliveries: NotificationDeliveryEntity[] = [];
  const deps = {
    notificationRepo: {
      create: (notification: UserNotificationEntity) => {
        created.push(notification);
        return Promise.resolve(notification);
      },
      updateStatus: () => Promise.resolve(),
    },
    notificationRuleRepo: { listByProjectId: () => Promise.resolve(rules) },
    deliveryRepo: {
      create: (delivery: NotificationDeliveryEntity) => {
        deliveries.push(delivery);
        return Promise.resolve(delivery);
      },
      save: <T>(delivery: T) => Promise.resolve(delivery),
    },
    adapterRegistry: {
      get: (channel: NotificationChannel) =>
        channel === "in_app"
          ? {
              channel,
              deliver: () =>
                Promise.resolve({ externalUrl: null, externalId: null }),
            }
          : undefined,
    },
  } as unknown as NotifyRepoConversationDeps;
  return { deps, created, deliveries };
};

const input = (event: "answer_ready" | "failed") => ({
  event,
  projectId: createUuidV7(),
  taskId: createUuidV7(),
  conversationId: createUuidV7(),
  recipientUserId: createUuidV7(),
  now: NOW,
});

describe("notifyRepoConversation", () => {
  concurrentTest(
    "an answer tells the creator, content-free, with the conversation in the payload",
    async () => {
      const { deps, created } = fakeDeps();
      const answer = input("answer_ready");

      await notifyRepoConversation(answer, deps, tx);

      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        kind: "result_ready",
        recipientUserId: answer.recipientUserId,
        audience: "specific_users",
        title: "Repo conversation answer ready",
        taskId: answer.taskId,
        workItemId: null,
        pipelineExecutionId: null,
        payloadJson: { conversationId: answer.conversationId },
      });
    },
  );

  concurrentTest("a final failure sends a warning", async () => {
    const { deps, created } = fakeDeps();
    const failed = input("failed");

    await notifyRepoConversation(failed, deps, tx);

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      kind: "warning",
      title: "Repo conversation failed",
      workItemId: null,
      payloadJson: { conversationId: failed.conversationId },
    });
  });

  concurrentTest("nobody is notified when the creator is unknown", async () => {
    const { deps, created } = fakeDeps();

    await notifyRepoConversation(
      { ...input("answer_ready"), recipientUserId: null },
      deps,
      tx,
    );

    expect(created).toEqual([]);
  });

  concurrentTest(
    "never delivers a work item platform comment, even when a rule enables it",
    async () => {
      const answer = input("answer_ready");
      const rule = NotificationRuleEntity.create({
        projectId: answer.projectId,
        kind: "result_ready",
        channel: "work_item_platform_comment",
        enabled: true,
        minPriority: null,
        conditionsJson: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const { deps, deliveries } = fakeDeps([rule]);

      await notifyRepoConversation(answer, deps, tx);

      expect(
        deliveries.map(({ channel, status, suppressionReason }) => ({
          channel,
          status,
          suppressionReason,
        })),
      ).toEqual([
        { channel: "in_app", status: "pending", suppressionReason: null },
        {
          channel: "work_item_platform_comment",
          status: "suppressed",
          suppressionReason: NOT_APPLICABLE_WITHOUT_WORK_ITEM,
        },
      ]);
    },
  );
});

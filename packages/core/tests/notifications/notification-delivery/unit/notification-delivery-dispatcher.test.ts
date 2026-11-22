import { describe, expect } from "bun:test";
import { concurrentTest } from "tests/utils";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import type { UuidV7 } from "@/common/contracts/uuid-v7";
import { dispatchNotificationDeliveries } from "@/notifications/notification-delivery/application/notification-delivery-dispatcher";
import type { NotificationDeliveryRepo } from "@/notifications/notification-delivery/application/notification-delivery-repo";
import type {
  DeliverResult,
  NotificationChannelAdapter,
  NotificationChannelAdapterRegistry,
} from "@/notifications/notification-delivery/application/notification-channel-adapter";
import { type NotificationDeliveryEntity } from "@/notifications/notification-delivery/domain/notification-delivery-entity";
import {
  WORK_ITEM_PLATFORM_COMMENT_CHANNEL,
  type NotificationChannel,
} from "@/notifications/notification-delivery/contracts/notification-delivery-contracts";
import { UserNotificationEntity } from "@/notifications/user-notification/domain/user-notification-entity";
import type { UserNotificationRepo } from "@/notifications/user-notification/application/user-notification-repo";
import type { UserNotificationStatus } from "@/notifications/user-notification/contracts/user-notification-contracts";
import type { ChannelDecision } from "@/notifications/notification-policy/domain/notification-policy";

class FakeDeliveryRepo implements NotificationDeliveryRepo {
  public readonly created: NotificationDeliveryEntity[] = [];
  public readonly saved: NotificationDeliveryEntity[] = [];

  create(
    entity: NotificationDeliveryEntity,
  ): Promise<NotificationDeliveryEntity> {
    this.created.push(entity);
    return Promise.resolve(entity);
  }

  save(entity: NotificationDeliveryEntity): Promise<void> {
    this.saved.push(entity);
    return Promise.resolve();
  }

  listByNotificationId(): Promise<NotificationDeliveryEntity[]> {
    return Promise.resolve([]);
  }

  listPendingWorkItemPlatformCommentDrafts(): ReturnType<
    NotificationDeliveryRepo["listPendingWorkItemPlatformCommentDrafts"]
  > {
    return Promise.resolve([]);
  }
}

class FakeNotificationRepo implements UserNotificationRepo {
  public readonly statusUpdates: Array<{
    id: UuidV7;
    status: UserNotificationStatus;
  }> = [];

  create(entity: UserNotificationEntity): Promise<UserNotificationEntity> {
    return Promise.resolve(entity);
  }

  load(): Promise<UserNotificationEntity | null> {
    return Promise.resolve(null);
  }

  list(): Promise<UserNotificationEntity[]> {
    return Promise.resolve([]);
  }

  updateStatus(id: UuidV7, status: UserNotificationStatus): Promise<void> {
    this.statusUpdates.push({ id, status });
    return Promise.resolve();
  }

  save(): Promise<void> {
    return Promise.resolve();
  }

  deleteByTaskOrConversation(): Promise<number> {
    return Promise.resolve(0);
  }

  deleteByProjectId(): Promise<number> {
    return Promise.resolve(0);
  }
}

class FakeAdapterRegistry implements NotificationChannelAdapterRegistry {
  private readonly adapters = new Map<
    NotificationChannel,
    NotificationChannelAdapter
  >();
  public readonly getCalls: NotificationChannel[] = [];

  register(adapter: NotificationChannelAdapter): void {
    this.adapters.set(adapter.channel, adapter);
  }

  get(channel: NotificationChannel): NotificationChannelAdapter | undefined {
    this.getCalls.push(channel);
    return this.adapters.get(channel);
  }
}

const buildAdapter = (
  channel: NotificationChannel,
  deliver: (
    ...args: Parameters<NotificationChannelAdapter["deliver"]>
  ) => Promise<DeliverResult>,
): NotificationChannelAdapter => ({
  channel,
  deliver,
});

const buildNotification = (): UserNotificationEntity =>
  UserNotificationEntity.create({
    projectId: createUuidV7(),
    workItemId: null,
    pipelineExecutionId: null,
    taskId: null,
    agentSessionId: null,
    recipientUserId: null,
    kind: "status_update",
    audience: "assignee",
    title: "Test notification",
    body: "Body",
    priority: "normal",
    source: "agent",
    payloadJson: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

describe("dispatchNotificationDeliveries", () => {
  concurrentTest(
    "work_item_platform_comment: creates a pending delivery row and never calls the adapter registry",
    async () => {
      const notification = buildNotification();
      const deliveryRepo = new FakeDeliveryRepo();
      const notificationRepo = new FakeNotificationRepo();
      // Deliberately no adapter registered for this channel: if the
      // dispatcher fell through to the normal adapter-lookup path instead of
      // hitting the special case, this would mark the delivery
      // "no_adapter_registered"/"failed" rather than leaving it "pending".
      const adapterRegistry = new FakeAdapterRegistry();

      const decisions: ChannelDecision[] = [
        {
          channel: WORK_ITEM_PLATFORM_COMMENT_CHANNEL,
          allowed: true,
          suppressionReason: null,
        },
      ];

      await dispatchNotificationDeliveries(notification, decisions, {
        notificationRepo,
        deliveryRepo,
        adapterRegistry,
      });

      expect(deliveryRepo.created).toHaveLength(1);
      expect(deliveryRepo.created[0]?.status).toBe("pending");
      expect(deliveryRepo.created[0]?.channel).toBe(
        WORK_ITEM_PLATFORM_COMMENT_CHANNEL,
      );

      // No save() call either: the special case never transitions the row
      // after creation (no markSent/markFailed).
      expect(deliveryRepo.saved).toHaveLength(0);

      expect(adapterRegistry.getCalls).not.toContain(
        WORK_ITEM_PLATFORM_COMMENT_CHANNEL,
      );

      expect(notificationRepo.statusUpdates).toEqual([
        { id: notification.id, status: "pending" },
      ]);
    },
  );

  concurrentTest(
    "work_item_platform_comment: a policy-denied decision is still suppressed at creation time, without reaching the special case",
    async () => {
      const notification = buildNotification();
      const deliveryRepo = new FakeDeliveryRepo();
      const notificationRepo = new FakeNotificationRepo();
      const adapterRegistry = new FakeAdapterRegistry();

      const decisions: ChannelDecision[] = [
        {
          channel: WORK_ITEM_PLATFORM_COMMENT_CHANNEL,
          allowed: false,
          suppressionReason: "no_policy_rule",
        },
      ];

      await dispatchNotificationDeliveries(notification, decisions, {
        notificationRepo,
        deliveryRepo,
        adapterRegistry,
      });

      expect(deliveryRepo.created).toHaveLength(1);
      expect(deliveryRepo.created[0]?.status).toBe("suppressed");
      expect(deliveryRepo.created[0]?.suppressionReason).toBe("no_policy_rule");
      expect(deliveryRepo.saved).toHaveLength(0);
      expect(adapterRegistry.getCalls).toHaveLength(0);

      expect(notificationRepo.statusUpdates).toEqual([
        { id: notification.id, status: "suppressed" },
      ]);
    },
  );

  concurrentTest(
    "a normal adapter-backed channel (in_app) is unaffected by the special case",
    async () => {
      const notification = buildNotification();
      const deliveryRepo = new FakeDeliveryRepo();
      const notificationRepo = new FakeNotificationRepo();
      const adapterRegistry = new FakeAdapterRegistry();
      adapterRegistry.register(
        buildAdapter("in_app", () =>
          Promise.resolve({
            externalId: "ext-1",
            externalUrl: "https://example.test/1",
          }),
        ),
      );

      const decisions: ChannelDecision[] = [
        { channel: "in_app", allowed: true, suppressionReason: null },
      ];

      await dispatchNotificationDeliveries(notification, decisions, {
        notificationRepo,
        deliveryRepo,
        adapterRegistry,
      });

      expect(adapterRegistry.getCalls).toEqual(["in_app"]);
      expect(deliveryRepo.saved).toHaveLength(1);
      expect(deliveryRepo.saved[0]?.status).toBe("sent");
      expect(deliveryRepo.saved[0]?.externalId).toBe("ext-1");

      expect(notificationRepo.statusUpdates).toEqual([
        { id: notification.id, status: "delivered" },
      ]);
    },
  );

  concurrentTest(
    "a normal adapter-backed channel that throws is marked failed, independent of the special case",
    async () => {
      const notification = buildNotification();
      const deliveryRepo = new FakeDeliveryRepo();
      const notificationRepo = new FakeNotificationRepo();
      const adapterRegistry = new FakeAdapterRegistry();
      adapterRegistry.register(
        buildAdapter("in_app", () => Promise.reject(new Error("boom"))),
      );

      const decisions: ChannelDecision[] = [
        { channel: "in_app", allowed: true, suppressionReason: null },
      ];

      await dispatchNotificationDeliveries(notification, decisions, {
        notificationRepo,
        deliveryRepo,
        adapterRegistry,
      });

      expect(deliveryRepo.saved).toHaveLength(1);
      expect(deliveryRepo.saved[0]?.status).toBe("failed");
      expect(deliveryRepo.saved[0]?.suppressionReason).toBe("boom");

      expect(notificationRepo.statusUpdates).toEqual([
        { id: notification.id, status: "failed" },
      ]);
    },
  );

  concurrentTest(
    "mixed decisions: in_app delivers immediately while work_item_platform_comment becomes an independent pending draft",
    async () => {
      const notification = buildNotification();
      const deliveryRepo = new FakeDeliveryRepo();
      const notificationRepo = new FakeNotificationRepo();
      const adapterRegistry = new FakeAdapterRegistry();
      adapterRegistry.register(
        buildAdapter("in_app", () =>
          Promise.resolve({ externalId: null, externalUrl: null }),
        ),
      );

      const decisions: ChannelDecision[] = [
        { channel: "in_app", allowed: true, suppressionReason: null },
        {
          channel: WORK_ITEM_PLATFORM_COMMENT_CHANNEL,
          allowed: true,
          suppressionReason: null,
        },
      ];

      await dispatchNotificationDeliveries(notification, decisions, {
        notificationRepo,
        deliveryRepo,
        adapterRegistry,
      });

      expect(deliveryRepo.created).toHaveLength(2);

      const inAppDelivery = deliveryRepo.created.find(
        (d) => d.channel === "in_app",
      );
      const draftDelivery = deliveryRepo.created.find(
        (d) => d.channel === WORK_ITEM_PLATFORM_COMMENT_CHANNEL,
      );

      // in_app was created pending, then transitioned via save() to sent.
      expect(deliveryRepo.saved).toHaveLength(1);
      expect(deliveryRepo.saved[0]?.channel).toBe("in_app");
      expect(deliveryRepo.saved[0]?.status).toBe("sent");

      // the draft channel was only ever created, never saved/transitioned.
      expect(draftDelivery?.status).toBe("pending");
      expect(inAppDelivery?.status).toBe("pending");

      expect(adapterRegistry.getCalls).toEqual(["in_app"]);

      // UserNotificationEntity.deriveStatus(["sent", "pending"]) === "pending"
      expect(notificationRepo.statusUpdates).toEqual([
        { id: notification.id, status: "pending" },
      ]);
    },
  );
});

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { AnyJsonObject } from "@scarn/core/common/contracts/json";
import {
  notificationDeliveries,
  userNotifications,
} from "@scarn/core/lib/db/schema";
import {
  UserNotificationEntity,
  type UserNotificationEntityProps,
} from "@scarn/core/notifications/user-notification/domain/user-notification-entity";
import { WORK_ITEM_PLATFORM_COMMENT_CHANNEL } from "../contracts/notification-delivery-contracts";
import type {
  NotificationDeliveryRepo,
  PendingWorkItemPlatformCommentDraft,
} from "../application/notification-delivery-repo";
import {
  NotificationDeliveryEntity,
  type NotificationDeliveryEntityProps,
} from "../domain/notification-delivery-entity";

const toRow = (entity: NotificationDeliveryEntity) => ({
  id: entity.id,
  notificationId: entity.notificationId,
  channel: entity.channel,
  status: entity.status,
  suppressionReason: entity.suppressionReason,
  externalUrl: entity.externalUrl,
  externalId: entity.externalId,
  artifactResolutionJson: entity.artifactResolutionJson,
  createdAt: entity.createdAt,
  sentAt: entity.sentAt,
});

export class DrizzleNotificationDeliveryRepo implements NotificationDeliveryRepo {
  private toEntity(
    row: typeof notificationDeliveries.$inferSelect,
  ): NotificationDeliveryEntity {
    return NotificationDeliveryEntity.rehydrate({
      id: parseUuidV7(row.id),
      notificationId: parseUuidV7(row.notificationId),
      channel: row.channel,
      status: row.status,
      suppressionReason: row.suppressionReason,
      externalUrl: row.externalUrl,
      externalId: row.externalId,
      artifactResolutionJson:
        (row.artifactResolutionJson as AnyJsonObject | null) ?? null,
      createdAt: row.createdAt,
      sentAt: row.sentAt,
    } satisfies NotificationDeliveryEntityProps);
  }

  private toNotificationEntity(
    row: typeof userNotifications.$inferSelect,
  ): UserNotificationEntity {
    return UserNotificationEntity.rehydrate({
      id: parseUuidV7(row.id),
      projectId: parseUuidV7(row.projectId),
      workItemId: row.workItemId ? parseUuidV7(row.workItemId) : null,
      pipelineExecutionId: row.pipelineExecutionId
        ? parseUuidV7(row.pipelineExecutionId)
        : null,
      taskId: row.taskId ? parseUuidV7(row.taskId) : null,
      agentSessionId: row.agentSessionId
        ? parseUuidV7(row.agentSessionId)
        : null,
      recipientUserId: row.recipientUserId
        ? parseUuidV7(row.recipientUserId)
        : null,
      kind: row.kind,
      audience: row.audience,
      title: row.title,
      body: row.body,
      priority: row.priority,
      source: row.source,
      status: row.status,
      payloadJson: (row.payloadJson as AnyJsonObject | null) ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } satisfies UserNotificationEntityProps);
  }

  async create(
    entity: NotificationDeliveryEntity,
    dbExecutor?: DbExecutor,
  ): Promise<NotificationDeliveryEntity> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .insert(notificationDeliveries)
      .values(toRow(entity))
      .returning();

    if (!row) {
      throw new Error("Failed to create notification delivery");
    }

    return this.toEntity(row);
  }

  async save(
    entity: NotificationDeliveryEntity,
    dbExecutor?: DbExecutor,
  ): Promise<void> {
    const db = dbExecutor ?? getDb();
    await db
      .update(notificationDeliveries)
      .set({
        status: entity.status,
        suppressionReason: entity.suppressionReason,
        externalUrl: entity.externalUrl,
        externalId: entity.externalId,
        artifactResolutionJson: entity.artifactResolutionJson,
        sentAt: entity.sentAt,
      })
      .where(eq(notificationDeliveries.id, entity.id));
  }

  async listByNotificationId(
    notificationId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<NotificationDeliveryEntity[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.notificationId, notificationId));

    return rows.map((row) => this.toEntity(row));
  }

  async listPendingWorkItemPlatformCommentDrafts(
    workItemId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<PendingWorkItemPlatformCommentDraft[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select({
        delivery: notificationDeliveries,
        notification: userNotifications,
      })
      .from(notificationDeliveries)
      .innerJoin(
        userNotifications,
        eq(notificationDeliveries.notificationId, userNotifications.id),
      )
      .where(
        and(
          eq(
            notificationDeliveries.channel,
            WORK_ITEM_PLATFORM_COMMENT_CHANNEL,
          ),
          inArray(notificationDeliveries.status, ["pending", "failed"]),
          eq(userNotifications.workItemId, workItemId),
        ),
      );

    return rows.map((row) => ({
      delivery: this.toEntity(row.delivery),
      notification: this.toNotificationEntity(row.notification),
    }));
  }
}

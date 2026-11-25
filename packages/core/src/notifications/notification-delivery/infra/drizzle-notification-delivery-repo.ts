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
import { noopLogger, type Logger } from "@scarn/observability/logging";
import { readStoredArtifactResolutionJson } from "@scarn/core/notifications/comment-artifacts/contracts/artifact-resolution-stored";
import { userNotificationFromRow } from "@scarn/core/notifications/user-notification/infra/user-notification-row";
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

type NotificationDeliveryRow = typeof notificationDeliveries.$inferSelect;

/**
 * A delivery's artifact resolution. It is a delivery record, read for
 * display and retry only, so an unreadable one is logged and read as none
 * rather than failing the read.
 */
const artifactResolutionFromRow = (
  row: NotificationDeliveryRow,
  logger: Logger,
): AnyJsonObject | null => {
  const read = readStoredArtifactResolutionJson(
    row.artifactResolutionJson ?? null,
  );
  if (!read.success) {
    logger.error(
      {
        table: "notification_deliveries",
        notificationId: row.notificationId,
        deliveryId: row.id,
        reason: read.reason,
      },
      "Stored artifact resolution is unreadable; reading the delivery without it",
    );
    return null;
  }
  return read.value;
};

export class DrizzleNotificationDeliveryRepo implements NotificationDeliveryRepo {
  constructor(private readonly logger: Logger = noopLogger) {}

  private toEntity(row: NotificationDeliveryRow): NotificationDeliveryEntity {
    return NotificationDeliveryEntity.rehydrate({
      id: parseUuidV7(row.id),
      notificationId: parseUuidV7(row.notificationId),
      channel: row.channel,
      status: row.status,
      suppressionReason: row.suppressionReason,
      externalUrl: row.externalUrl,
      externalId: row.externalId,
      artifactResolutionJson: artifactResolutionFromRow(row, this.logger),
      createdAt: row.createdAt,
      sentAt: row.sentAt,
    } satisfies NotificationDeliveryEntityProps);
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
      notification: userNotificationFromRow(row.notification, this.logger),
    }));
  }
}

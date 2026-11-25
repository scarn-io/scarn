import type { AnyJsonObject } from "@scarn/core/common/contracts/json";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { userNotifications } from "@scarn/core/lib/db/schema";
import type { Logger } from "@scarn/observability/logging";
import { readStoredUserNotificationPayload } from "../contracts/user-notification-payload-stored";
import {
  UserNotificationEntity,
  type UserNotificationEntityProps,
} from "../domain/user-notification-entity";

export type UserNotificationRow = typeof userNotifications.$inferSelect;

/**
 * A notification's payload. Notifications are short-lived and the renderer
 * falls back on an unknown payload, so an unreadable one is logged and read
 * as no payload rather than failing the read.
 */
const payloadFromRow = (
  row: UserNotificationRow,
  logger: Logger,
): AnyJsonObject | null => {
  const read = readStoredUserNotificationPayload(row.payloadJson ?? null);
  if (!read.success) {
    logger.error(
      {
        table: "user_notifications",
        projectId: row.projectId,
        notificationId: row.id,
        reason: read.reason,
      },
      "Stored payload is unreadable; reading the notification without it",
    );
    return null;
  }
  return read.value;
};

/** Rehydrates a `user_notifications` row, reading its payload through the stored reader. */
export const userNotificationFromRow = (
  row: UserNotificationRow,
  logger: Logger,
): UserNotificationEntity =>
  UserNotificationEntity.rehydrate({
    id: parseUuidV7(row.id),
    projectId: parseUuidV7(row.projectId),
    workItemId: row.workItemId ? parseUuidV7(row.workItemId) : null,
    pipelineExecutionId: row.pipelineExecutionId
      ? parseUuidV7(row.pipelineExecutionId)
      : null,
    taskId: row.taskId ? parseUuidV7(row.taskId) : null,
    agentSessionId: row.agentSessionId ? parseUuidV7(row.agentSessionId) : null,
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
    payloadJson: payloadFromRow(row, logger),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  } satisfies UserNotificationEntityProps);

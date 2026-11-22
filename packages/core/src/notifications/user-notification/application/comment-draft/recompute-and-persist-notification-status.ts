import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { NotificationDeliveryRepo } from "@scarn/core/notifications/notification-delivery/application/notification-delivery-repo";
import {
  UserNotificationEntity,
  type DeliveryOutcome,
} from "../../domain/user-notification-entity";
import type { UserNotificationRepo } from "../user-notification-repo";
import type { UserNotificationStatus } from "../../contracts/user-notification-contracts";

/**
 * Reloads every delivery row for `notificationId`, maps each to a
 * `DeliveryOutcome` (a delivery's own `status` values are a strict subset of
 * `DeliveryOutcome`, so no translation is needed), derives the notification's
 * overall status via `UserNotificationEntity.deriveStatus()`, and persists it.
 * Returns the derived status so the caller can shape a fresh contract without
 * a second read.
 *
 * Shared by `approveCommentDraft` and `rejectCommentDraft` (Decisions 5/6):
 * both mutate a single delivery row and then need to recompute the parent
 * notification's status from *all* of its deliveries, not just the one they
 * touched, so an unrelated channel's outcome (e.g. an already-`"sent"`
 * `in_app` delivery) is never clobbered.
 */
export const recomputeAndPersistNotificationStatus = async (
  notificationId: UuidV7,
  notificationDeliveryRepo: NotificationDeliveryRepo,
  userNotificationRepo: UserNotificationRepo,
  dbExecutor?: DbExecutor,
): Promise<UserNotificationStatus> => {
  const deliveries = await notificationDeliveryRepo.listByNotificationId(
    notificationId,
    dbExecutor,
  );
  const outcomes: DeliveryOutcome[] = deliveries.map(
    (candidate) => candidate.status,
  );
  const status = UserNotificationEntity.deriveStatus(outcomes);
  await userNotificationRepo.updateStatus(notificationId, status, dbExecutor);
  return status;
};

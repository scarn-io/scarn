import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  ResourceConflictError,
  ResourceNotFoundError,
} from "@scarn/core/lib/errors";
import { WORK_ITEM_PLATFORM_COMMENT_CHANNEL } from "@scarn/core/notifications/notification-delivery/contracts/notification-delivery-contracts";
import type { NotificationDeliveryEntity } from "@scarn/core/notifications/notification-delivery/domain/notification-delivery-entity";
import type { NotificationDeliveryRepo } from "@scarn/core/notifications/notification-delivery/application/notification-delivery-repo";
import type { UserNotificationEntity } from "../../domain/user-notification-entity";
import type { UserNotificationRepo } from "../user-notification-repo";

export type PendingCommentDraft = {
  notification: UserNotificationEntity;
  delivery: NotificationDeliveryEntity;
};

/**
 * Shared "load + assert" preamble for both `approveCommentDraft` and
 * `rejectCommentDraft`: load the notification by id, then find its
 * `work_item_platform_comment` delivery row — the delivery row, not the
 * notification's `kind`, is what makes a notification a "comment draft"
 * (Decision 8/12). There is no `projectId` param here deliberately — these
 * routes are flat (`/work-item-comment-drafts/:notificationId/...`, no
 * `:projectId` in the URL, mirroring `work-item-comments.ts`'s routes), so
 * the notification's own `projectId` is the source of truth for the
 * permission check the caller performs immediately after this resolves
 * (the same "load first, authorize against the loaded row's projectId"
 * pattern used by `edit-work-item-comment.ts`/`delete-work-item-comment.ts`).
 * A notification with no `work_item_platform_comment` delivery at all is
 * treated as "not found" from this endpoint's perspective; a delivery whose
 * status is already terminal (`"sent"` or `"suppressed"`, per Decision 7) is
 * a 409 conflict rather than a 404, since the row does exist but is no
 * longer actionable.
 */
export const loadPendingCommentDraft = async (
  notificationId: UuidV7,
  userNotificationRepo: UserNotificationRepo,
  notificationDeliveryRepo: NotificationDeliveryRepo,
  dbExecutor?: DbExecutor,
): Promise<PendingCommentDraft> => {
  const notification = await userNotificationRepo.load(
    notificationId,
    dbExecutor,
  );

  if (!notification) {
    throw new ResourceNotFoundError("User notification", notificationId);
  }

  const deliveries = await notificationDeliveryRepo.listByNotificationId(
    notificationId,
    dbExecutor,
  );
  const delivery = deliveries.find(
    (candidate) => candidate.channel === WORK_ITEM_PLATFORM_COMMENT_CHANNEL,
  );

  if (!delivery) {
    throw new ResourceNotFoundError("Comment draft", notificationId);
  }

  if (delivery.status === "sent" || delivery.status === "suppressed") {
    throw new ResourceConflictError("Comment draft", notificationId);
  }

  return { notification, delivery };
};

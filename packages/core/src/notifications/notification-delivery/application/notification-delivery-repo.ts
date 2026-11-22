import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserNotificationEntity } from "@scarn/core/notifications/user-notification/domain/user-notification-entity";
import type { NotificationDeliveryEntity } from "../domain/notification-delivery-entity";

export type PendingWorkItemPlatformCommentDraft = {
  delivery: NotificationDeliveryEntity;
  notification: UserNotificationEntity;
};

export interface NotificationDeliveryRepo {
  create(
    entity: NotificationDeliveryEntity,
    dbExecutor?: DbExecutor,
  ): Promise<NotificationDeliveryEntity>;
  save(
    entity: NotificationDeliveryEntity,
    dbExecutor?: DbExecutor,
  ): Promise<void>;
  listByNotificationId(
    notificationId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<NotificationDeliveryEntity[]>;
  /**
   * Every still-actionable (`pending` or `failed`, per Decision 7)
   * `work_item_platform_comment` delivery for a work item, joined to its
   * parent notification. The delivery row is the source of truth for "is
   * this a draft" (Decision 12), so this starts from `notification_deliveries`
   * rather than filtering `user_notifications` by a since-removed kind.
   */
  listPendingWorkItemPlatformCommentDrafts(
    workItemId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<PendingWorkItemPlatformCommentDraft[]>;
}

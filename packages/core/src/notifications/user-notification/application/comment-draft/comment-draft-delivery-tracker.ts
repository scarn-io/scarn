import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { NotificationDeliveryRepo } from "@scarn/core/notifications/notification-delivery/application/notification-delivery-repo";
import type { NotificationDeliveryEntity } from "@scarn/core/notifications/notification-delivery/domain/notification-delivery-entity";

/**
 * Holds the latest saved state of the delivery being approved, so outcomes
 * saved mid-approval (before the platform post) aren't lost when the delivery
 * is later marked sent or failed.
 */
export type CommentDraftDeliveryTracker = {
  readonly current: NotificationDeliveryEntity;
  update(
    change: (current: NotificationDeliveryEntity) => NotificationDeliveryEntity,
  ): Promise<void>;
};

export const createCommentDraftDeliveryTracker = (
  delivery: NotificationDeliveryEntity,
  deps: {
    notificationDeliveryRepo: NotificationDeliveryRepo;
    dbExecutor?: DbExecutor;
  },
): CommentDraftDeliveryTracker => {
  let current = delivery;
  return {
    get current() {
      return current;
    },
    async update(change) {
      const next = change(current);
      await deps.notificationDeliveryRepo.save(next, deps.dbExecutor);
      current = next;
    },
  };
};

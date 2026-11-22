import type { AnyJsonObject } from "@scarn/core/common/contracts/json";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  UserNotificationEntity,
  type DeliveryOutcome,
} from "@scarn/core/notifications/user-notification/domain/user-notification-entity";
import type { UserNotificationRepo } from "@scarn/core/notifications/user-notification/application/user-notification-repo";
import type { ChannelDecision } from "@scarn/core/notifications/notification-policy/domain/notification-policy";
import { NotificationDeliveryEntity } from "../domain/notification-delivery-entity";
import { WORK_ITEM_PLATFORM_COMMENT_CHANNEL } from "../contracts/notification-delivery-contracts";
import type { NotificationDeliveryRepo } from "./notification-delivery-repo";
import type { NotificationChannelAdapterRegistry } from "./notification-channel-adapter";

export type DispatchChannelDecision = ChannelDecision & {
  artifactResolutionJson?: AnyJsonObject | null;
};

export type NotificationDeliveryDispatcherDeps = {
  notificationRepo: UserNotificationRepo;
  deliveryRepo: NotificationDeliveryRepo;
  adapterRegistry: NotificationChannelAdapterRegistry;
};

/**
 * Creates a delivery row per channel decision, runs the adapter for each
 * allowed channel, then recomputes and persists the parent notification status.
 * Runs inline within the originating transaction.
 */
export const dispatchNotificationDeliveries = async (
  notification: UserNotificationEntity,
  decisions: readonly DispatchChannelDecision[],
  deps: NotificationDeliveryDispatcherDeps,
  dbExecutor?: DbExecutor,
): Promise<void> => {
  const outcomes: DeliveryOutcome[] = [];

  for (const decision of decisions) {
    let delivery = await deps.deliveryRepo.create(
      NotificationDeliveryEntity.create({
        notificationId: notification.id,
        channel: decision.channel,
        status: decision.allowed ? "pending" : "suppressed",
        suppressionReason: decision.suppressionReason,
        externalUrl: null,
        externalId: null,
        artifactResolutionJson: decision.artifactResolutionJson ?? null,
      }),
      dbExecutor,
    );

    if (!decision.allowed) {
      outcomes.push("suppressed");
      continue;
    }

    if (decision.channel === WORK_ITEM_PLATFORM_COMMENT_CHANNEL) {
      outcomes.push("pending");
      continue;
    }

    const adapter = deps.adapterRegistry.get(decision.channel);
    if (!adapter) {
      delivery = delivery.markFailed("no_adapter_registered");
      await deps.deliveryRepo.save(delivery, dbExecutor);
      outcomes.push("failed");
      continue;
    }

    try {
      const result = await adapter.deliver(notification, delivery);
      delivery = delivery.markSent(result, new Date());
      await deps.deliveryRepo.save(delivery, dbExecutor);
      outcomes.push("sent");
    } catch (error) {
      const reason = error instanceof Error ? error.message : "delivery_failed";
      delivery = delivery.markFailed(reason);
      await deps.deliveryRepo.save(delivery, dbExecutor);
      outcomes.push("failed");
    }
  }

  const status = UserNotificationEntity.deriveStatus(outcomes);
  await deps.notificationRepo.updateStatus(notification.id, status, dbExecutor);
};

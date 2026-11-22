import type { UserNotificationEntity } from "@scarn/core/notifications/user-notification/domain/user-notification-entity";
import type { NotificationChannel } from "../contracts/notification-delivery-contracts";
import type { NotificationDeliveryEntity } from "../domain/notification-delivery-entity";

export type DeliverResult = {
  externalId?: string | null;
  externalUrl?: string | null;
};

/**
 * One channel's send strategy. Implementations are pure transport — they do not
 * decide whether a delivery is allowed (that is the policy's job) and they do
 * not persist (the dispatcher persists the resulting status).
 */
export interface NotificationChannelAdapter {
  readonly channel: NotificationChannel;
  deliver(
    notification: UserNotificationEntity,
    delivery: NotificationDeliveryEntity,
  ): Promise<DeliverResult>;
}

export interface NotificationChannelAdapterRegistry {
  get(channel: NotificationChannel): NotificationChannelAdapter | undefined;
}

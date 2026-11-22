import type {
  DeliverResult,
  NotificationChannelAdapter,
} from "../../application/notification-channel-adapter";

/**
 * In-app delivery is simply persistence + the read API. There is nothing
 * external to send, so "delivering" succeeds immediately and the notification
 * becomes visible through the project notifications list.
 */
export class InAppNotificationAdapter implements NotificationChannelAdapter {
  readonly channel = "in_app" as const;

  deliver(): Promise<DeliverResult> {
    return Promise.resolve({ externalId: null, externalUrl: null });
  }
}

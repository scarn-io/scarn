import type { NotificationChannel } from "../../contracts/notification-delivery-contracts";
import type {
  DeliverResult,
  NotificationChannelAdapter,
} from "../../application/notification-channel-adapter";

/**
 * Placeholder adapter for channels whose transport is not yet implemented
 * (email, slack). It is registered so that policy can target the
 * channel and exercise suppression; if policy ever allows a delivery to a
 * not-yet-built channel, the dispatcher marks it failed with a clear reason
 * rather than silently dropping it.
 */
export class UnimplementedChannelAdapter implements NotificationChannelAdapter {
  constructor(public readonly channel: NotificationChannel) {}

  deliver(): Promise<DeliverResult> {
    return Promise.reject(
      new Error(`Notification channel "${this.channel}" is not implemented yet`),
    );
  }
}

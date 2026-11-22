import type { NotificationChannel } from "../contracts/notification-delivery-contracts";
import type {
  NotificationChannelAdapter,
  NotificationChannelAdapterRegistry,
} from "../application/notification-channel-adapter";
import { InAppNotificationAdapter } from "./adapters/in-app-adapter";
import { UnimplementedChannelAdapter } from "./adapters/unimplemented-channel-adapter";

export class DefaultNotificationChannelAdapterRegistry
  implements NotificationChannelAdapterRegistry
{
  private readonly adapters: Map<
    NotificationChannel,
    NotificationChannelAdapter
  >;

  constructor(adapters?: readonly NotificationChannelAdapter[]) {
    const defaults: NotificationChannelAdapter[] = [
      new InAppNotificationAdapter(),
      new UnimplementedChannelAdapter("email"),
      new UnimplementedChannelAdapter("slack"),
    ];
    this.adapters = new Map(
      [...defaults, ...(adapters ?? [])].map((a) => [a.channel, a]),
    );
  }

  get(channel: NotificationChannel): NotificationChannelAdapter | undefined {
    return this.adapters.get(channel);
  }
}

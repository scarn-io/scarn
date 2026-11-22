import { z } from "zod";
import {
  anyJsonValueSchema,
  type AnyJsonValue,
} from "@scarn/core/common/contracts/json";
import {
  notificationPrioritySchema,
  userNotificationKindSchema,
} from "./user-notification-contracts";
import { notificationChannelSchema } from "@scarn/core/notifications/notification-delivery/contracts/notification-delivery-contracts";

/**
 * The signal key the agent emits via the SDK `Features.notifications()` feature.
 * Keep this string in sync with the SDK (`$scarn_notifications_v1`). The
 * platform owns its own parser so its domain logic does not depend on the
 * client SDK internals.
 */
export const NOTIFICATION_SIGNAL_KEY = "$scarn_notifications_v1";

export const notificationSignalItemSchema = z.object({
  kind: userNotificationKindSchema,
  title: z.string().optional(),
  body: z.string(),
  priority: notificationPrioritySchema,
  suggestedChannels: z.array(notificationChannelSchema).optional(),
  payload: z.record(z.string(), anyJsonValueSchema).optional(),
});

export type NotificationSignalItem = z.infer<typeof notificationSignalItemSchema>;

export const parseNotificationSignalItems = (
  valueJson: AnyJsonValue,
): NotificationSignalItem[] | undefined => {
  const parsed = z.array(notificationSignalItemSchema).safeParse(valueJson);
  return parsed.success ? parsed.data : undefined;
};

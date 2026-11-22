import { z } from "zod";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";

export const notificationChannelSchema = z.enum([
  "in_app",
  "work_item_platform_comment",
  "email",
  "slack",
]);

/**
 * The channel that unconditionally bypasses policy evaluation and normal
 * adapter-based delivery in favor of becoming a pending, human-reviewed
 * draft. See `docs/plans/route-comment-drafts-by-channel.md`.
 */
export const WORK_ITEM_PLATFORM_COMMENT_CHANNEL =
  "work_item_platform_comment" satisfies z.infer<
    typeof notificationChannelSchema
  >;

export const notificationDeliveryStatusSchema = z.enum([
  "pending",
  "sent",
  "failed",
  "suppressed",
]);

export const notificationDeliverySchema = z.object({
  id: uuidV7Schema,
  notificationId: uuidV7Schema,
  channel: notificationChannelSchema,
  status: notificationDeliveryStatusSchema,
  suppressionReason: z.string().nullable(),
  externalUrl: z.string().nullable(),
  externalId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  sentAt: z.iso.datetime().nullable(),
});

export type NotificationDeliveryContract = z.infer<
  typeof notificationDeliverySchema
>;
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;
export type NotificationDeliveryStatus = z.infer<
  typeof notificationDeliveryStatusSchema
>;

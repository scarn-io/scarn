import { z } from "zod";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { anyJsonObjectSchema } from "@scarn/core/common/contracts/json";
import {
  notificationPrioritySchema,
  userNotificationKindSchema,
} from "@scarn/core/notifications/user-notification/contracts/user-notification-contracts";
import { notificationChannelSchema } from "@scarn/core/notifications/notification-delivery/contracts/notification-delivery-contracts";

export const notificationRuleSchema = z.object({
  id: uuidV7Schema,
  projectId: uuidV7Schema,
  kind: userNotificationKindSchema,
  channel: notificationChannelSchema,
  enabled: z.boolean(),
  minPriority: notificationPrioritySchema.nullable(),
  conditionsJson: anyJsonObjectSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const upsertNotificationRuleSchema = z.object({
  kind: userNotificationKindSchema,
  channel: notificationChannelSchema,
  enabled: z.boolean(),
  minPriority: notificationPrioritySchema.nullable(),
  conditionsJson: anyJsonObjectSchema.nullable(),
});

export type NotificationRuleContract = z.infer<typeof notificationRuleSchema>;
export type UpsertNotificationRuleInput = z.infer<
  typeof upsertNotificationRuleSchema
>;

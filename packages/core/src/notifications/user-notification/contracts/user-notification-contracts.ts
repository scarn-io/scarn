import { z } from "zod";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { anyJsonObjectSchema } from "@scarn/core/common/contracts/json";
import { notificationDeliverySchema } from "@scarn/core/notifications/notification-delivery/contracts/notification-delivery-contracts";

export const userNotificationKindSchema = z.enum([
  "feedback_request",
  "status_update",
  "blocked",
  "result_ready",
  "warning",
  "integration_auto_sync_paused",
]);

export const notificationAudienceSchema = z.enum([
  "assignee",
  "reporter",
  "project_admins",
  "specific_users",
]);

export const notificationPrioritySchema = z.enum([
  "low",
  "normal",
  "high",
  "urgent",
]);

export const notificationSourceSchema = z.enum(["agent", "system", "user"]);

export const userNotificationStatusSchema = z.enum([
  "pending",
  "delivered",
  "partially_delivered",
  "suppressed",
  "failed",
]);

export const userNotificationSchema = z.object({
  id: uuidV7Schema,
  projectId: uuidV7Schema,
  workItemId: uuidV7Schema.nullable(),
  pipelineExecutionId: uuidV7Schema.nullable(),
  taskId: uuidV7Schema.nullable(),
  agentSessionId: uuidV7Schema.nullable(),
  /** The one person it is for; null for a notification to the whole project. */
  recipientUserId: uuidV7Schema.nullable(),
  kind: userNotificationKindSchema,
  audience: notificationAudienceSchema,
  title: z.string(),
  body: z.string(),
  priority: notificationPrioritySchema,
  source: notificationSourceSchema,
  status: userNotificationStatusSchema,
  payloadJson: anyJsonObjectSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const userNotificationWithDeliveriesSchema =
  userNotificationSchema.extend({
    deliveries: z.array(notificationDeliverySchema),
  });

const commentDraftArtifactRefSchema = z.union([
  z.object({
    type: z.literal("signal"),
    stepKey: z.string(),
    signalKey: z.string(),
  }),
  z.object({ type: z.literal("path"), pattern: z.string() }),
]);

/**
 * The draft's per-marker artifact resolution (from
 * `notification_deliveries.artifact_resolution_json`), as the review UI reads
 * it. `markerIndex` matches the order of the markers in the draft body.
 */
export const commentDraftArtifactResolutionSchema = z.object({
  markers: z.array(
    z.object({
      markerIndex: z.number().int().nonnegative(),
      kind: z.enum(["embed", "link"]),
      ref: commentDraftArtifactRefSchema,
      caption: z.string(),
      standalone: z.boolean(),
      status: z.enum(["resolved", "unavailable"]),
      required: z.boolean(),
      reason: z.string().nullable(),
      artifact: z
        .object({
          artifactId: uuidV7Schema,
          name: z.string(),
          contentType: z.string().nullable(),
          kind: z.string(),
          sizeBytes: z.number().int().nonnegative().nullable(),
        })
        .nullable(),
    }),
  ),
  leftOut: z.array(
    z.object({
      markerIndex: z.number().int().nonnegative(),
      ref: commentDraftArtifactRefSchema,
      caption: z.string(),
      reason: z.string(),
    }),
  ),
  warnings: z.array(
    z.object({
      markerIndex: z.number().int().nonnegative(),
      code: z.string(),
      message: z.string(),
    }),
  ),
});

export const pendingCommentDraftSchema = z.object({
  notification: userNotificationSchema,
  lastError: z.string().nullable(),
  artifactResolution: commentDraftArtifactResolutionSchema.nullable(),
});

export type UserNotificationContract = z.infer<typeof userNotificationSchema>;
export type UserNotificationWithDeliveriesContract = z.infer<
  typeof userNotificationWithDeliveriesSchema
>;
export type CommentDraftArtifactResolutionContract = z.infer<
  typeof commentDraftArtifactResolutionSchema
>;
export type PendingCommentDraftContract = z.infer<
  typeof pendingCommentDraftSchema
>;
export type UserNotificationKind = z.infer<typeof userNotificationKindSchema>;
export type NotificationAudience = z.infer<typeof notificationAudienceSchema>;
export type NotificationPriority = z.infer<typeof notificationPrioritySchema>;
export type NotificationSource = z.infer<typeof notificationSourceSchema>;
export type UserNotificationStatus = z.infer<
  typeof userNotificationStatusSchema
>;

import type { UserNotificationEntity } from "../domain/user-notification-entity";
import type { NotificationDeliveryEntity } from "@scarn/core/notifications/notification-delivery/domain/notification-delivery-entity";
import type {
  UserNotificationContract,
  UserNotificationWithDeliveriesContract,
} from "../contracts/user-notification-contracts";
import type { NotificationDeliveryContract } from "@scarn/core/notifications/notification-delivery/contracts/notification-delivery-contracts";

export const userNotificationToContract = (
  entity: UserNotificationEntity,
): UserNotificationContract => ({
  id: entity.id,
  projectId: entity.projectId,
  workItemId: entity.workItemId,
  pipelineExecutionId: entity.pipelineExecutionId,
  taskId: entity.taskId,
  agentSessionId: entity.agentSessionId,
  recipientUserId: entity.recipientUserId,
  kind: entity.kind,
  audience: entity.audience,
  title: entity.title,
  body: entity.body,
  priority: entity.priority,
  source: entity.source,
  status: entity.status,
  payloadJson: entity.payloadJson,
  createdAt: entity.createdAt.toISOString(),
  updatedAt: entity.updatedAt.toISOString(),
});

export const notificationDeliveryToContract = (
  entity: NotificationDeliveryEntity,
): NotificationDeliveryContract => ({
  id: entity.id,
  notificationId: entity.notificationId,
  channel: entity.channel,
  status: entity.status,
  suppressionReason: entity.suppressionReason,
  externalUrl: entity.externalUrl,
  externalId: entity.externalId,
  createdAt: entity.createdAt.toISOString(),
  sentAt: entity.sentAt ? entity.sentAt.toISOString() : null,
});

export const userNotificationWithDeliveriesToContract = (
  entity: UserNotificationEntity,
  deliveries: readonly NotificationDeliveryEntity[],
): UserNotificationWithDeliveriesContract => ({
  ...userNotificationToContract(entity),
  deliveries: deliveries.map(notificationDeliveryToContract),
});

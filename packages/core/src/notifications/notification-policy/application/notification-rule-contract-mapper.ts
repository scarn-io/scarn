import type { NotificationRuleEntity } from "../domain/notification-rule-entity";
import type { NotificationRuleContract } from "../contracts/notification-rule-contracts";

export const notificationRuleToContract = (
  entity: NotificationRuleEntity,
): NotificationRuleContract => ({
  id: entity.id,
  projectId: entity.projectId,
  kind: entity.kind,
  channel: entity.channel,
  enabled: entity.enabled,
  minPriority: entity.minPriority,
  conditionsJson: entity.conditionsJson,
  createdAt: entity.createdAt.toISOString(),
  updatedAt: entity.updatedAt.toISOString(),
});

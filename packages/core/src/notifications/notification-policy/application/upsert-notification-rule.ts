import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { NotificationRuleEntity } from "../domain/notification-rule-entity";
import type {
  NotificationRuleContract,
  UpsertNotificationRuleInput,
} from "../contracts/notification-rule-contracts";
import type { NotificationRuleRepo } from "./notification-rule-repo";
import { notificationRuleToContract } from "./notification-rule-contract-mapper";

type UpsertNotificationRuleArgs = {
  projectId: UuidV7;
  rule: UpsertNotificationRuleInput;
};

type UpsertNotificationRuleDeps = {
  userAuthz: UserAuthorizationService;
  notificationRuleRepo: NotificationRuleRepo;
};

export const upsertNotificationRule = async (
  input: UpsertNotificationRuleArgs,
  deps: UpsertNotificationRuleDeps,
): Promise<NotificationRuleContract> => {
  await deps.userAuthz.requireProjectPermission({
    projectId: input.projectId,
    permission: "settings:write",
  });

  const now = new Date();
  const entity = NotificationRuleEntity.create({
    projectId: input.projectId,
    kind: input.rule.kind,
    channel: input.rule.channel,
    enabled: input.rule.enabled,
    minPriority: input.rule.minPriority,
    conditionsJson: input.rule.conditionsJson,
    createdAt: now,
    updatedAt: now,
  });

  return notificationRuleToContract(
    await deps.notificationRuleRepo.upsert(entity),
  );
};

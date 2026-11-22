import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { NotificationRuleContract } from "../contracts/notification-rule-contracts";
import type { NotificationRuleRepo } from "./notification-rule-repo";
import { notificationRuleToContract } from "./notification-rule-contract-mapper";

type ListNotificationRulesInput = {
  projectId: UuidV7;
};

type ListNotificationRulesDeps = {
  userAuthz: UserAuthorizationService;
  notificationRuleRepo: NotificationRuleRepo;
};

export const listNotificationRules = async (
  input: ListNotificationRulesInput,
  deps: ListNotificationRulesDeps,
): Promise<NotificationRuleContract[]> => {
  await deps.userAuthz.requireProjectPermission({
    projectId: input.projectId,
    permission: "executions:read",
  });

  return (
    await deps.notificationRuleRepo.listByProjectId(input.projectId)
  ).map(notificationRuleToContract);
};

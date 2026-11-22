import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type {
  NotificationPriority,
  UserNotificationKind,
} from "@scarn/core/notifications/user-notification/contracts/user-notification-contracts";
import type { NotificationChannel } from "@scarn/core/notifications/notification-delivery/contracts/notification-delivery-contracts";
import {
  evaluateNotificationPolicy,
  type ChannelDecision,
} from "../domain/notification-policy";
import type { NotificationRuleRepo } from "./notification-rule-repo";

export type EvaluatePolicyInput = {
  projectId: UuidV7;
  kind: UserNotificationKind;
  priority: NotificationPriority;
  suggestedChannels: readonly NotificationChannel[];
};

export class NotificationPolicyService {
  constructor(private readonly notificationRuleRepo: NotificationRuleRepo) {}

  async evaluate(
    input: EvaluatePolicyInput,
    dbExecutor?: DbExecutor,
  ): Promise<ChannelDecision[]> {
    const rules = await this.notificationRuleRepo.listByProjectId(
      input.projectId,
      dbExecutor,
    );

    return evaluateNotificationPolicy({
      kind: input.kind,
      priority: input.priority,
      suggestedChannels: input.suggestedChannels,
      rules,
    });
  }
}

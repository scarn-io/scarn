import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { NotificationRuleEntity } from "../domain/notification-rule-entity";

export interface NotificationRuleRepo {
  listByProjectId(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<NotificationRuleEntity[]>;
  upsert(
    entity: NotificationRuleEntity,
    dbExecutor?: DbExecutor,
  ): Promise<NotificationRuleEntity>;
}

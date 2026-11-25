import { eq } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { AnyJsonObject } from "@scarn/core/common/contracts/json";
import { notificationRules } from "@scarn/core/lib/db/schema";
import { noopLogger, type Logger } from "@scarn/observability/logging";
import type { NotificationRuleRepo } from "../application/notification-rule-repo";
import { readStoredNotificationRuleConditions } from "../contracts/notification-rule-conditions-stored";
import {
  NotificationRuleEntity,
  type NotificationRuleEntityProps,
} from "../domain/notification-rule-entity";

const toRow = (entity: NotificationRuleEntity) => ({
  id: entity.id,
  projectId: entity.projectId,
  kind: entity.kind,
  channel: entity.channel,
  enabled: entity.enabled,
  minPriority: entity.minPriority,
  conditionsJson: entity.conditionsJson,
  createdAt: entity.createdAt,
  updatedAt: entity.updatedAt,
});

type NotificationRuleRow = typeof notificationRules.$inferSelect;

/**
 * A rule's conditions. The column is reserved and nothing reads it yet, so
 * an unreadable value is logged and read as none rather than failing the
 * read.
 */
const conditionsFromRow = (
  row: NotificationRuleRow,
  logger: Logger,
): AnyJsonObject | null => {
  const read = readStoredNotificationRuleConditions(row.conditionsJson ?? null);
  if (!read.success) {
    logger.error(
      {
        table: "notification_rules",
        projectId: row.projectId,
        ruleId: row.id,
        reason: read.reason,
      },
      "Stored conditions are unreadable; reading the rule without them",
    );
    return null;
  }
  return read.value;
};

export class DrizzleNotificationRuleRepo implements NotificationRuleRepo {
  constructor(private readonly logger: Logger = noopLogger) {}

  private toEntity(row: NotificationRuleRow): NotificationRuleEntity {
    return NotificationRuleEntity.rehydrate({
      id: parseUuidV7(row.id),
      projectId: parseUuidV7(row.projectId),
      kind: row.kind,
      channel: row.channel,
      enabled: row.enabled,
      minPriority: row.minPriority,
      conditionsJson: conditionsFromRow(row, this.logger),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } satisfies NotificationRuleEntityProps);
  }

  async listByProjectId(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<NotificationRuleEntity[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(notificationRules)
      .where(eq(notificationRules.projectId, projectId));

    return rows.map((row) => this.toEntity(row));
  }

  async upsert(
    entity: NotificationRuleEntity,
    dbExecutor?: DbExecutor,
  ): Promise<NotificationRuleEntity> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .insert(notificationRules)
      .values(toRow(entity))
      .onConflictDoUpdate({
        target: [
          notificationRules.projectId,
          notificationRules.kind,
          notificationRules.channel,
        ],
        set: {
          enabled: entity.enabled,
          minPriority: entity.minPriority,
          conditionsJson: entity.conditionsJson,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (!row) {
      throw new Error("Failed to upsert notification rule");
    }

    return this.toEntity(row);
  }
}

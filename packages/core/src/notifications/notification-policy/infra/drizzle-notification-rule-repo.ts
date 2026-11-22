import { eq } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { AnyJsonObject } from "@scarn/core/common/contracts/json";
import { notificationRules } from "@scarn/core/lib/db/schema";
import type { NotificationRuleRepo } from "../application/notification-rule-repo";
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

export class DrizzleNotificationRuleRepo implements NotificationRuleRepo {
  private toEntity(
    row: typeof notificationRules.$inferSelect,
  ): NotificationRuleEntity {
    return NotificationRuleEntity.rehydrate({
      id: parseUuidV7(row.id),
      projectId: parseUuidV7(row.projectId),
      kind: row.kind,
      channel: row.channel,
      enabled: row.enabled,
      minPriority: row.minPriority,
      conditionsJson: (row.conditionsJson as AnyJsonObject | null) ?? null,
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

import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { AnyJsonObject } from "@scarn/core/common/contracts/json";
import { userNotifications } from "@scarn/core/lib/db/schema";
import type {
  ListUserNotificationsFilter,
  UserNotificationRepo,
} from "../application/user-notification-repo";
import {
  UserNotificationEntity,
  type UserNotificationEntityProps,
} from "../domain/user-notification-entity";
import type { UserNotificationStatus } from "../contracts/user-notification-contracts";

const toRow = (entity: UserNotificationEntity) => ({
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
  createdAt: entity.createdAt,
  updatedAt: entity.updatedAt,
});

export class DrizzleUserNotificationRepo implements UserNotificationRepo {
  private toEntity(
    row: typeof userNotifications.$inferSelect,
  ): UserNotificationEntity {
    return UserNotificationEntity.rehydrate({
      id: parseUuidV7(row.id),
      projectId: parseUuidV7(row.projectId),
      workItemId: row.workItemId ? parseUuidV7(row.workItemId) : null,
      pipelineExecutionId: row.pipelineExecutionId
        ? parseUuidV7(row.pipelineExecutionId)
        : null,
      taskId: row.taskId ? parseUuidV7(row.taskId) : null,
      agentSessionId: row.agentSessionId
        ? parseUuidV7(row.agentSessionId)
        : null,
      recipientUserId: row.recipientUserId
        ? parseUuidV7(row.recipientUserId)
        : null,
      kind: row.kind,
      audience: row.audience,
      title: row.title,
      body: row.body,
      priority: row.priority,
      source: row.source,
      status: row.status,
      payloadJson: (row.payloadJson as AnyJsonObject | null) ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } satisfies UserNotificationEntityProps);
  }

  async create(
    entity: UserNotificationEntity,
    dbExecutor?: DbExecutor,
  ): Promise<UserNotificationEntity> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .insert(userNotifications)
      .values(toRow(entity))
      .returning();

    if (!row) {
      throw new Error("Failed to create user notification");
    }

    return this.toEntity(row);
  }

  async load(
    id: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<UserNotificationEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(userNotifications)
      .where(eq(userNotifications.id, id))
      .limit(1);

    return row ? this.toEntity(row) : null;
  }

  async list(
    filter: ListUserNotificationsFilter,
    dbExecutor?: DbExecutor,
  ): Promise<UserNotificationEntity[]> {
    const db = dbExecutor ?? getDb();
    const conditions = [
      eq(userNotifications.projectId, filter.projectId),
      or(
        eq(userNotifications.recipientUserId, filter.viewerUserId),
        isNull(userNotifications.recipientUserId),
      ),
    ];
    if (filter.workItemId) {
      conditions.push(eq(userNotifications.workItemId, filter.workItemId));
    }
    if (filter.status) {
      conditions.push(eq(userNotifications.status, filter.status));
    }

    const rows = await db
      .select()
      .from(userNotifications)
      .where(and(...conditions))
      .orderBy(desc(userNotifications.createdAt));

    return rows.map((row) => this.toEntity(row));
  }

  async updateStatus(
    id: UuidV7,
    status: UserNotificationStatus,
    dbExecutor?: DbExecutor,
  ): Promise<void> {
    const db = dbExecutor ?? getDb();
    await db
      .update(userNotifications)
      .set({ status, updatedAt: new Date() })
      .where(eq(userNotifications.id, id));
  }

  async save(
    entity: UserNotificationEntity,
    dbExecutor?: DbExecutor,
  ): Promise<void> {
    const db = dbExecutor ?? getDb();
    await db
      .update(userNotifications)
      .set({
        status: entity.status,
        payloadJson: entity.payloadJson,
        updatedAt: new Date(),
      })
      .where(eq(userNotifications.id, entity.id));
  }

  async deleteByTaskOrConversation(
    target: { projectId: UuidV7; taskId: UuidV7; conversationId: UuidV7 },
    dbExecutor?: DbExecutor,
  ): Promise<number> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .delete(userNotifications)
      .where(
        and(
          eq(userNotifications.projectId, target.projectId),
          or(
            eq(userNotifications.taskId, target.taskId),
            sql`${userNotifications.payloadJson}->>'conversationId' = ${target.conversationId}`,
          ),
        ),
      )
      .returning({ id: userNotifications.id });

    return rows.length;
  }

  async deleteByProjectId(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<number> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .delete(userNotifications)
      .where(eq(userNotifications.projectId, projectId))
      .returning({ id: userNotifications.id });

    return rows.length;
  }
}

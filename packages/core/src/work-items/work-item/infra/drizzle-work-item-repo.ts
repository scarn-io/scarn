import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { PersistenceError } from "@scarn/core/lib/errors";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { workItems } from "@scarn/core/lib/db/schema";
import type {
  WorkItemFieldOption,
  WorkItemListPage,
  WorkItemListPageOptions,
  WorkItemRepo,
} from "../application/work-item-repo";
import {
  queryWorkItemFieldOptions,
  queryWorkItemListPage,
} from "./work-item-listing-query";
import { queryWorkItemLabels } from "./work-item-labels-query";
import {
  WorkItemEntity,
  type WorkItemEntityProps,
} from "../domain/work-item-entity";
import { WorkItemDescriptionConflict } from "../domain/work-item-description-conflict";
import {
  toClosureColumns,
  toWorkItemRow,
  workItemUpsertSet,
} from "./work-item-row";
import type { WorkItemFields } from "../domain/work-item-field-value";
import { parseWorkItemId, type WorkItemId } from "../domain/work-item-id";
import type { WorkItemPlatform } from "../domain/work-item-platform";

export class DrizzleWorkItemRepo implements WorkItemRepo {
  private toEntity(row: typeof workItems.$inferSelect): WorkItemEntity {
    return WorkItemEntity.rehydrate({
      id: parseWorkItemId(row.id),
      projectId: row.projectId as UuidV7,
      platform: row.platform,
      platformId: row.platformId,
      platformKey: row.platformKey,
      url: row.url,
      title: row.title,
      description: row.description,
      descriptionVersion: row.descriptionVersion,
      sourceCreatedAt: row.sourceCreatedAt,
      sourceUpdatedAt: row.sourceUpdatedAt,
      fields: (row.fields ?? {}) as WorkItemFields,
      labels: row.labels,
      createdByUserId: row.createdByUserId as UuidV7 | null,
      assigneeUserId: row.assigneeUserId as UuidV7 | null,
      parentWorkItemId: row.parentWorkItemId
        ? parseWorkItemId(row.parentWorkItemId)
        : null,
      state: row.state,
      closure:
        row.closeReason && row.closedAt
          ? {
              reason: row.closeReason,
              resolution: row.resolution,
              closedAt: row.closedAt,
              closedByUserId: row.closedByUserId as UuidV7 | null,
              closedByTaskId: row.closedByTaskId as UuidV7 | null,
            }
          : null,
      spawnedByTaskId: row.spawnedByTaskId as UuidV7 | null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } satisfies WorkItemEntityProps);
  }

  async load(
    id: WorkItemId,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(workItems)
      .where(eq(workItems.id, id))
      .limit(1);

    return row ? this.toEntity(row) : null;
  }

  async loadMany(
    ids: WorkItemId[],
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemEntity[]> {
    if (ids.length === 0) {
      return [];
    }

    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(workItems)
      .where(inArray(workItems.id, ids));

    return rows.map((row) => this.toEntity(row));
  }

  async listChildren(
    parentWorkItemId: WorkItemId,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemEntity[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(workItems)
      .where(eq(workItems.parentWorkItemId, parentWorkItemId))
      .orderBy(asc(workItems.createdAt));

    return rows.map((row) => this.toEntity(row));
  }

  async countSpawnedByTask(
    taskId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<number> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(workItems)
      .where(eq(workItems.spawnedByTaskId, taskId));

    return row?.count ?? 0;
  }

  async listPageByProjectId(
    projectId: UuidV7,
    options: WorkItemListPageOptions,
    now: Date,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemListPage> {
    const db = dbExecutor ?? getDb();
    const { rows, total } = await queryWorkItemListPage(
      db,
      projectId,
      options,
      now,
    );

    return {
      items: rows.map((row) => ({
        workItem: this.toEntity(row.workItem),
        signalScore: row.signalScore,
        latestExecutionStatus: row.latestExecutionStatus,
        awaitingApprovalCount: row.awaitingApprovalCount,
        taskStatusCounts: row.taskStatusCounts,
      })),
      total,
    };
  }

  async listFieldOptions(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemFieldOption[]> {
    const db = dbExecutor ?? getDb();

    return await queryWorkItemFieldOptions(db, projectId);
  }

  async listLabels(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<string[]> {
    return await queryWorkItemLabels(dbExecutor ?? getDb(), projectId);
  }

  async loadByPlatformIdentity(
    projectId: UuidV7,
    platform: typeof workItems.$inferSelect.platform,
    sourceIdentity: string,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemEntity | null> {
    const [workItem] = await this.loadManyByPlatformIdentities(
      [{ projectId, platform, sourceIdentity }],
      dbExecutor,
    );

    return workItem ?? null;
  }

  async loadManyByPlatformIdentities(
    identities: {
      projectId: UuidV7;
      platform: WorkItemPlatform;
      sourceIdentity: string;
    }[],
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemEntity[]> {
    if (identities.length === 0) {
      return [];
    }

    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(workItems)
      .where(
        or(
          ...identities.map((identity) =>
            and(
              eq(workItems.platform, identity.platform),
              eq(workItems.platformKey, identity.sourceIdentity),
              eq(workItems.projectId, identity.projectId),
            ),
          ),
        ),
      );

    return rows.map((row) => this.toEntity(row));
  }

  async save(
    workItem: WorkItemEntity,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemEntity> {
    const [savedWorkItem] = await this.upsertMany(
      [workItem],
      "scarn",
      dbExecutor,
    );

    if (!savedWorkItem) {
      throw new PersistenceError(
        `Failed to save work item ${workItem.id}`,
        "WORK_ITEM_SAVE_FAILED",
      );
    }

    return savedWorkItem;
  }

  async create(
    workItem: WorkItemEntity,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemEntity> {
    const [createdWorkItem] = await this.createMany([workItem], dbExecutor);

    if (!createdWorkItem) {
      throw new PersistenceError(
        `Failed to create work item ${workItem.id}`,
        "WORK_ITEM_CREATE_FAILED",
      );
    }

    return createdWorkItem;
  }

  async createMany(
    workItemEntities: WorkItemEntity[],
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemEntity[]> {
    if (workItemEntities.length === 0) {
      return [];
    }

    const db = dbExecutor ?? getDb();
    const rows = await db
      .insert(workItems)
      .values(workItemEntities.map((workItem) => toWorkItemRow(workItem)))
      .onConflictDoNothing({
        target: [
          workItems.projectId,
          workItems.platform,
          workItems.platformKey,
        ],
      })
      .returning();

    return rows.map((row) => this.toEntity(row));
  }

  async saveMany(
    workItemEntities: WorkItemEntity[],
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemEntity[]> {
    return await this.upsertMany(workItemEntities, "sync", dbExecutor);
  }

  async saveDescription(
    workItem: WorkItemEntity,
    expectedVersion: number,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemEntity> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .update(workItems)
      .set({
        description: workItem.description,
        descriptionVersion: sql`case when ${workItems.description} is distinct from ${workItem.description} then ${workItems.descriptionVersion} + 1 else ${workItems.descriptionVersion} end`,
        updatedAt: workItem.updatedAt ?? new Date(),
      })
      .where(
        and(
          eq(workItems.id, workItem.id),
          eq(workItems.descriptionVersion, expectedVersion),
        ),
      )
      .returning();

    if (!row) {
      throw new WorkItemDescriptionConflict(workItem.id, expectedVersion);
    }

    return this.toEntity(row);
  }

  private async upsertMany(
    workItemEntities: WorkItemEntity[],
    writer: "sync" | "scarn",
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemEntity[]> {
    if (workItemEntities.length === 0) {
      return [];
    }

    const db = dbExecutor ?? getDb();
    const rows = await db
      .insert(workItems)
      .values(workItemEntities.map((workItem) => toWorkItemRow(workItem)))
      .onConflictDoUpdate({
        target: [
          workItems.projectId,
          workItems.platform,
          workItems.platformKey,
        ],
        set: workItemUpsertSet(writer),
      })
      .returning();

    return rows.map((row) => this.toEntity(row));
  }

  async saveManyIfSourceNewer(
    workItemEntities: WorkItemEntity[],
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemEntity[]> {
    if (workItemEntities.length === 0) {
      return [];
    }

    const db = dbExecutor ?? getDb();
    const rows = await db
      .insert(workItems)
      .values(workItemEntities.map((workItem) => toWorkItemRow(workItem)))
      .onConflictDoUpdate({
        target: [
          workItems.projectId,
          workItems.platform,
          workItems.platformKey,
        ],
        // Atomic idempotency guard (decisions 6/12): only apply the update
        // when the incoming row is strictly newer than what's stored, or
        // nothing was stored yet. A stale/out-of-order conflicting row is
        // left untouched and dropped from `RETURNING` entirely — see the
        // interface doc comment on `WorkItemRepo.saveManyIfSourceNewer`.
        setWhere: sql.raw(
          `excluded.${workItems.sourceUpdatedAt.name} > work_items.${workItems.sourceUpdatedAt.name} or work_items.${workItems.sourceUpdatedAt.name} is null`,
        ),
        set: workItemUpsertSet("sync"),
      })
      .returning();

    return rows.map((row) => this.toEntity(row));
  }

  async setStateMany(
    workItemEntities: WorkItemEntity[],
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemEntity[]> {
    const db = dbExecutor ?? getDb();
    const updated: WorkItemEntity[] = [];

    for (const workItem of workItemEntities) {
      const [row] = await db
        .update(workItems)
        .set({
          state: workItem.state,
          ...toClosureColumns(workItem),
          updatedAt: workItem.updatedAt ?? new Date(),
        })
        .where(
          and(
            eq(workItems.id, workItem.id),
            ne(workItems.state, workItem.state),
          ),
        )
        .returning();

      if (row) {
        updated.push(this.toEntity(row));
      }
    }

    return updated;
  }

  async delete(id: WorkItemId, dbExecutor?: DbExecutor): Promise<number> {
    return await this.deleteMany([id], dbExecutor);
  }

  async deleteMany(
    ids: WorkItemId[],
    dbExecutor?: DbExecutor,
  ): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }

    const db = dbExecutor ?? getDb();
    const rows = await db
      .delete(workItems)
      .where(inArray(workItems.id, ids))
      .returning({ id: workItems.id });

    return rows.length;
  }

  async deleteByProjectId(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<number> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .delete(workItems)
      .where(eq(workItems.projectId, projectId))
      .returning({ id: workItems.id });

    return rows.length;
  }
}

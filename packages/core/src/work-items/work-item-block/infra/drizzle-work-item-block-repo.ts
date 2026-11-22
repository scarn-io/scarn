import { and, asc, eq, inArray, or } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { PersistenceError } from "@scarn/core/lib/errors";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { workItemBlocks, workItems } from "@scarn/core/lib/db/schema";
import type { WorkItemBlockRepo } from "../application/work-item-block-repo";
import {
  WorkItemBlockEntity,
  type WorkItemBlockEntityProps,
} from "../domain/work-item-block-entity";
import {
  parseWorkItemBlockId,
  type WorkItemBlockId,
} from "../domain/work-item-block-id";
import { isWorkItemReachableViaBlocks } from "./work-item-block-reachability-subquery";

const toWorkItemBlockRow = (block: WorkItemBlockEntity) => ({
  id: block.id,
  projectId: block.projectId,
  blockedWorkItemId: block.blockedWorkItemId,
  blockingWorkItemId: block.blockingWorkItemId,
  createdByUserId: block.createdByUserId,
  createdAt: block.createdAt ?? new Date(),
});

export class DrizzleWorkItemBlockRepo implements WorkItemBlockRepo {
  private toEntity(
    row: typeof workItemBlocks.$inferSelect,
  ): WorkItemBlockEntity {
    return WorkItemBlockEntity.rehydrate({
      id: parseWorkItemBlockId(row.id),
      projectId: row.projectId as UuidV7,
      blockedWorkItemId: row.blockedWorkItemId as UuidV7,
      blockingWorkItemId: row.blockingWorkItemId as UuidV7,
      createdByUserId: row.createdByUserId as UuidV7 | null,
      createdAt: row.createdAt,
    } satisfies WorkItemBlockEntityProps);
  }

  async create(
    block: WorkItemBlockEntity,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemBlockEntity> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .insert(workItemBlocks)
      .values(toWorkItemBlockRow(block))
      .returning();

    if (!row) {
      throw new PersistenceError(
        `Failed to create work item block ${block.id}`,
        "WORK_ITEM_BLOCK_CREATE_FAILED",
      );
    }

    return this.toEntity(row);
  }

  async load(
    id: WorkItemBlockId,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemBlockEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(workItemBlocks)
      .where(eq(workItemBlocks.id, id))
      .limit(1);

    return row ? this.toEntity(row) : null;
  }

  async listByWorkItem(
    workItemId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemBlockEntity[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(workItemBlocks)
      .where(
        or(
          eq(workItemBlocks.blockedWorkItemId, workItemId),
          eq(workItemBlocks.blockingWorkItemId, workItemId),
        ),
      );

    return rows.map((row) => this.toEntity(row));
  }

  async loadByPair(
    blockedWorkItemId: UuidV7,
    blockingWorkItemId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemBlockEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(workItemBlocks)
      .where(
        and(
          eq(workItemBlocks.blockedWorkItemId, blockedWorkItemId),
          eq(workItemBlocks.blockingWorkItemId, blockingWorkItemId),
        ),
      )
      .limit(1);

    return row ? this.toEntity(row) : null;
  }

  async isReachable(
    projectId: UuidV7,
    fromWorkItemId: UuidV7,
    toWorkItemId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<boolean> {
    const db = dbExecutor ?? getDb();
    return isWorkItemReachableViaBlocks(
      db,
      projectId,
      fromWorkItemId,
      toWorkItemId,
    );
  }

  async listIdsWithOpenBlockers(
    workItemIds: UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<UuidV7[]> {
    if (workItemIds.length === 0) {
      return [];
    }
    const db = dbExecutor ?? getDb();
    const rows = await db
      .selectDistinct({ id: workItemBlocks.blockedWorkItemId })
      .from(workItemBlocks)
      .innerJoin(workItems, eq(workItems.id, workItemBlocks.blockingWorkItemId))
      .where(
        and(
          inArray(workItemBlocks.blockedWorkItemId, workItemIds),
          eq(workItems.state, "open"),
        ),
      );

    return rows.map((row) => row.id as UuidV7);
  }

  async listOpenBlockerIdsByBlocked(
    workItemIds: UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<Map<UuidV7, UuidV7[]>> {
    const byBlocked = new Map<UuidV7, UuidV7[]>();
    if (workItemIds.length === 0) {
      return byBlocked;
    }
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select({
        blockedId: workItemBlocks.blockedWorkItemId,
        blockingId: workItemBlocks.blockingWorkItemId,
      })
      .from(workItemBlocks)
      .innerJoin(workItems, eq(workItems.id, workItemBlocks.blockingWorkItemId))
      .where(
        and(
          inArray(workItemBlocks.blockedWorkItemId, workItemIds),
          eq(workItems.state, "open"),
        ),
      )
      .orderBy(asc(workItemBlocks.createdAt), asc(workItemBlocks.id));

    for (const row of rows) {
      const blockedId = row.blockedId as UuidV7;
      const ids = byBlocked.get(blockedId) ?? [];
      ids.push(row.blockingId as UuidV7);
      byBlocked.set(blockedId, ids);
    }
    return byBlocked;
  }

  async listIdsBlockedBy(
    blockingWorkItemIds: UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<UuidV7[]> {
    if (blockingWorkItemIds.length === 0) {
      return [];
    }
    const db = dbExecutor ?? getDb();
    const rows = await db
      .selectDistinct({ id: workItemBlocks.blockedWorkItemId })
      .from(workItemBlocks)
      .where(inArray(workItemBlocks.blockingWorkItemId, blockingWorkItemIds));

    return rows.map((row) => row.id as UuidV7);
  }

  async delete(id: WorkItemBlockId, dbExecutor?: DbExecutor): Promise<number> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .delete(workItemBlocks)
      .where(eq(workItemBlocks.id, id))
      .returning({ id: workItemBlocks.id });

    return rows.length;
  }
}

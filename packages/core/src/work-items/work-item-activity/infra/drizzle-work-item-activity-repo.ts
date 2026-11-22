import { asc, eq } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { workItemActivity } from "@scarn/core/lib/db/schema";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  parseWorkItemId,
  type WorkItemId,
} from "@scarn/core/work-items/work-item/domain/work-item-id";
import type { WorkItemActivityRepo } from "../application/work-item-activity-repo";
import { WorkItemActivityEntry } from "../domain/work-item-activity-entry";

export class DrizzleWorkItemActivityRepo implements WorkItemActivityRepo {
  async append(
    entry: WorkItemActivityEntry,
    dbExecutor?: DbExecutor,
  ): Promise<void> {
    await (dbExecutor ?? getDb()).insert(workItemActivity).values({
      id: entry.id,
      projectId: entry.projectId,
      workItemId: entry.workItemId,
      kind: entry.kind,
      message: entry.message,
      createdAt: entry.createdAt,
    });
  }

  async listByWorkItemId(
    workItemId: WorkItemId,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemActivityEntry[]> {
    const rows = await (dbExecutor ?? getDb())
      .select()
      .from(workItemActivity)
      .where(eq(workItemActivity.workItemId, workItemId))
      .orderBy(asc(workItemActivity.createdAt), asc(workItemActivity.id));
    return rows.map((row) =>
      WorkItemActivityEntry.rehydrate({
        id: parseUuidV7(row.id),
        projectId: parseUuidV7(row.projectId),
        workItemId: parseWorkItemId(row.workItemId),
        kind: row.kind,
        message: row.message,
        createdAt: row.createdAt,
      }),
    );
  }
}

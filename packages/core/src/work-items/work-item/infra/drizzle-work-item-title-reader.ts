import { inArray } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { workItems } from "@scarn/core/lib/db/schema";
import type { WorkItemTitleReader } from "../application/work-item-title-reader";
import type { WorkItemId } from "../domain/work-item-id";

/**
 * Resolves work item titles with a single `WHERE id IN (...)` selecting only
 * `(id, title)`, keeping title hydration to one round trip and two columns
 * regardless of how many executions a page references.
 */
export class DrizzleWorkItemTitleReader implements WorkItemTitleReader {
  async loadTitlesByWorkItemIds(
    workItemIds: readonly WorkItemId[],
    dbExecutor?: DbExecutor,
  ): Promise<Map<WorkItemId, string>> {
    const uniqueIds = [...new Set(workItemIds)];
    if (uniqueIds.length === 0) {
      return new Map<WorkItemId, string>();
    }

    const db = dbExecutor ?? getDb();
    const rows = await db
      .select({ id: workItems.id, title: workItems.title })
      .from(workItems)
      .where(inArray(workItems.id, uniqueIds));

    return new Map(rows.map((row) => [row.id as WorkItemId, row.title]));
  }
}

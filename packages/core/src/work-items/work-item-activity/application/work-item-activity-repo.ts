import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { WorkItemId } from "@scarn/core/work-items/work-item/domain/work-item-id";
import type { WorkItemActivityEntry } from "../domain/work-item-activity-entry";

export type WorkItemActivityRepo = {
  append(entry: WorkItemActivityEntry, dbExecutor?: DbExecutor): Promise<void>;
  /** Oldest first. */
  listByWorkItemId(
    workItemId: WorkItemId,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemActivityEntry[]>;
};

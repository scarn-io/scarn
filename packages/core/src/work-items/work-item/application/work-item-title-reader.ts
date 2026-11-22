import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { WorkItemId } from "../domain/work-item-id";

/**
 * Read-time resolver from a work item's id to its display `title`. Mirrors the
 * `UsernameReader` convention: consumers that reference a work item by id (such
 * as pipeline executions) resolve the title through this reader when building a
 * contract — it is never persisted onto their own rows.
 *
 * Deliberately narrower than `WorkItemRepo.loadMany`: it selects two columns
 * instead of rehydrating whole aggregates, so a list of N executions costs one
 * statement and N short strings rather than N full work items.
 */
export type WorkItemTitleReader = {
  /**
   * Batch-resolve a set of work item ids to their titles. The returned map only
   * contains ids that resolved to a row; unknown ids are omitted so callers can
   * decide their own fallback. De-duplicates ids before querying.
   */
  loadTitlesByWorkItemIds(
    workItemIds: readonly WorkItemId[],
    dbExecutor?: DbExecutor,
  ): Promise<Map<WorkItemId, string>>;
};

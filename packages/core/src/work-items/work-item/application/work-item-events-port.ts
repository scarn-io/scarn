import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";

/**
 * Told what happened to work items, in the transaction that made the change.
 * Work items own the port and never import what's behind it; `di.ts`
 * connects it to the automation aggregate's `AutomationRunner`.
 *
 * - `created`: items just inserted (a person's create, a sync's new rows, a
 *   child an agent creates).
 * - `mayHaveBecomeReady`: items whose readiness (open, no open blockers) may
 *   have changed: created and reopened items, the items a close or reopen
 *   was blocking, and the blocked item of a block added or removed. The
 *   listener checks readiness itself.
 * - `closed`: items that became closed.
 * - `labelsAdded`: the labels an item gained in one write (sync or Scarn).
 */
export type WorkItemEventsPort = {
  created(workItemIds: UuidV7[], tx: DbExecutor): Promise<void>;
  mayHaveBecomeReady(workItemIds: UuidV7[], tx: DbExecutor): Promise<void>;
  closed(workItemIds: UuidV7[], tx: DbExecutor): Promise<void>;
  labelsAdded(
    workItemId: UuidV7,
    labels: string[],
    tx: DbExecutor,
  ): Promise<void>;
};

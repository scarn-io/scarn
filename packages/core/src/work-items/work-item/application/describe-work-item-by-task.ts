import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { WorkItemEntity } from "../domain/work-item-entity";
import type { WorkItemRepo } from "./work-item-repo";

/**
 * The front door for an agent Task's description write: a compare-and-set
 * on `expectedVersion`, the `descriptionVersion` the agent read. Throws
 * `WorkItemDescriptionConflict` when someone wrote the description since.
 * Runs in the caller's transaction: the completion that carries the change.
 */
export const describeWorkItemByTask = async (
  workItem: WorkItemEntity,
  change: { description: string; expectedVersion: number },
  deps: { workItemRepo: WorkItemRepo; timeProvider: TimeProvider },
  tx: DbExecutor,
): Promise<WorkItemEntity> =>
  await deps.workItemRepo.saveDescription(
    workItem.describeByTask(change.description, deps.timeProvider.now()),
    change.expectedVersion,
    tx,
  );

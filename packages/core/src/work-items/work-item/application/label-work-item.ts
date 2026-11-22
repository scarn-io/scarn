import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { WorkItemEntity } from "../domain/work-item-entity";
import type { WorkItemEventsPort } from "./work-item-events-port";
import type { WorkItemRepo } from "./work-item-repo";

export type LabelWorkItemChange = {
  add?: readonly string[] | undefined;
  remove?: readonly string[] | undefined;
};

export type LabelWorkItemResult = {
  workItem: WorkItemEntity;
  /** Labels the item didn't have before this write. */
  addedLabels: string[];
};

/**
 * Adds then removes labels on a native work item (see
 * `WorkItemEntity.addLabels`). Synced items are refused: their labels come
 * from the tracker. Runs in the caller's transaction, and tells
 * `workItemEvents` about the labels the item gained.
 */
export const labelWorkItem = async (
  workItem: WorkItemEntity,
  change: LabelWorkItemChange,
  deps: {
    workItemRepo: WorkItemRepo;
    workItemEvents: WorkItemEventsPort;
    timeProvider: TimeProvider;
  },
  tx: DbExecutor,
): Promise<LabelWorkItemResult> => {
  const now = deps.timeProvider.now();
  const labelled = workItem
    .addLabels(change.add ?? [], now)
    .removeLabels(change.remove ?? [], now);
  const saved = await deps.workItemRepo.save(labelled, tx);
  const previous = new Set(workItem.labels);
  const addedLabels = saved.labels.filter((label) => !previous.has(label));
  if (addedLabels.length > 0) {
    await deps.workItemEvents.labelsAdded(
      parseUuidV7(saved.id),
      addedLabels,
      tx,
    );
  }

  return { workItem: saved, addedLabels };
};

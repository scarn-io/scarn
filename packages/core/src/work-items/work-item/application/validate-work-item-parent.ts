import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { CoreError } from "@scarn/core/lib/errors";
import type { WorkItemRepo } from "./work-item-repo";
import type { WorkItemEntity } from "../domain/work-item-entity";
import type { WorkItemId } from "../domain/work-item-id";

export type ValidateAndSetWorkItemParentDeps = {
  workItemRepo: WorkItemRepo;
  dbExecutor?: DbExecutor;
};

// Bounds the ancestor walk below so a corrupted/unexpectedly deep hierarchy
// can never hang the request — well beyond any hierarchy depth the product
// supports.
const MAX_ANCESTOR_WALK = 100;

/**
 * Walks `startingParent`'s ancestor chain (following `parentWorkItemId` up)
 * and throws `WORK_ITEM_PARENT_CYCLE` if `workItemId` appears in it — i.e. if
 * setting `workItemId`'s parent to `startingParent` would create a cycle.
 */
const rejectParentCycle = async (
  workItemId: WorkItemId,
  startingParent: WorkItemEntity,
  workItemRepo: WorkItemRepo,
  dbExecutor: DbExecutor | undefined,
): Promise<void> => {
  let ancestor: WorkItemEntity | null = startingParent;

  for (let hop = 0; hop < MAX_ANCESTOR_WALK; hop++) {
    if (!ancestor) {
      return;
    }

    if (ancestor.id === workItemId) {
      throw new CoreError({
        code: "WORK_ITEM_PARENT_CYCLE",
        message:
          "Setting this parent would create a cycle in the work item hierarchy",
        status: 422,
      });
    }

    if (!ancestor.parentWorkItemId) {
      return;
    }

    ancestor = await workItemRepo.load(ancestor.parentWorkItemId, dbExecutor);
  }
};

/**
 * Cross-project rejection, self-parent rejection, and the ancestor-chain
 * cycle walk, then returns the reparented entity via `workItem.setParent(...)`.
 * Persistence is the caller's responsibility.
 */
export const validateAndSetWorkItemParent = async (
  workItem: WorkItemEntity,
  parentWorkItem: WorkItemEntity | null,
  deps: ValidateAndSetWorkItemParentDeps,
  now: Date,
): Promise<WorkItemEntity> => {
  const { workItemRepo, dbExecutor } = deps;

  if (parentWorkItem) {
    if (parentWorkItem.projectId !== workItem.projectId) {
      throw new CoreError({
        code: "WORK_ITEM_PARENT_CROSS_PROJECT",
        message: "A work item's parent must belong to the same project",
        status: 422,
      });
    }

    if (parentWorkItem.id === workItem.id) {
      throw new CoreError({
        code: "WORK_ITEM_SELF_PARENT",
        message: "A work item cannot be its own parent",
        status: 422,
      });
    }

    await rejectParentCycle(workItem.id, parentWorkItem, workItemRepo, dbExecutor);
  }

  return workItem.setParent(parentWorkItem ? parentWorkItem.id : null, now);
};

import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { CoreError } from "@scarn/core/lib/errors";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { WorkItemEntity } from "@scarn/core/work-items/work-item/domain/work-item-entity";
import type { WorkItemBlockRepo } from "./work-item-block-repo";

export type ValidateWorkItemBlockCandidateDeps = {
  workItemBlockRepo: WorkItemBlockRepo;
  dbExecutor?: DbExecutor;
};

/**
 * Self-block rejection, cross-project rejection, direct-reciprocal-pair
 * rejection (via loadByPair), and the transitive-cycle reachability check,
 * all against `blockedWorkItem`/`blockingWorkItem`. Throws the same
 * `WORK_ITEM_SELF_BLOCK` / `WORK_ITEM_BLOCK_CROSS_PROJECT` /
 * `WORK_ITEM_BLOCK_RECIPROCAL` / `WORK_ITEM_BLOCK_CYCLE` `CoreError`s as
 * today. Does not persist.
 */
export const validateWorkItemBlockCandidate = async (
  blockedWorkItem: WorkItemEntity,
  blockingWorkItem: WorkItemEntity,
  deps: ValidateWorkItemBlockCandidateDeps,
): Promise<void> => {
  const { workItemBlockRepo, dbExecutor } = deps;

  if (blockedWorkItem.id === blockingWorkItem.id) {
    throw new CoreError({
      code: "WORK_ITEM_SELF_BLOCK",
      message: "A work item cannot block itself",
      status: 422,
    });
  }

  if (blockingWorkItem.projectId !== blockedWorkItem.projectId) {
    throw new CoreError({
      code: "WORK_ITEM_BLOCK_CROSS_PROJECT",
      message: "A blocking work item must belong to the same project",
      status: 422,
    });
  }

  // Direct 2-cycle: the reciprocal edge (blockingItem is already blocked by
  // blockedItem) already exists.
  const reciprocal = await workItemBlockRepo.loadByPair(
    parseUuidV7(blockingWorkItem.id),
    parseUuidV7(blockedWorkItem.id),
    dbExecutor,
  );
  if (reciprocal) {
    throw new CoreError({
      code: "WORK_ITEM_BLOCK_RECIPROCAL",
      message:
        "This work item already blocks the item it would be blocked by",
      status: 422,
    });
  }

  // Full transitive cycle (3+ nodes): the candidate edge is
  // `blockedWorkItem` depends on `blockingWorkItem`. That closes a cycle
  // exactly when `blockingWorkItem` already (transitively) depends on
  // `blockedWorkItem` — i.e. starting from `blockingWorkItem` and walking
  // the existing "blocked item -> its blocker" chain, `blockedWorkItem` is
  // reachable. Concretely, with existing edges A blocks B and B blocks C
  // (B depends on A, C depends on B), attempting "C blocks A" is rejected
  // because walking from C's blocker-chain (C -> B -> A) reaches A. Calling
  // `isReachable` with the arguments swapped from `blockedWorkItem`/
  // `blockingWorkItem`'s literal order would miss this: A has no existing
  // blocker chain of its own to walk.
  const wouldCloseCycle = await workItemBlockRepo.isReachable(
    blockedWorkItem.projectId,
    parseUuidV7(blockingWorkItem.id),
    parseUuidV7(blockedWorkItem.id),
    dbExecutor,
  );
  if (wouldCloseCycle) {
    throw new CoreError({
      code: "WORK_ITEM_BLOCK_CYCLE",
      message: "Creating this block would create a cycle",
      status: 422,
    });
  }
};

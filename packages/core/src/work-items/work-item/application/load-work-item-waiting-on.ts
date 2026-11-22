import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { WorkItemEntity } from "../domain/work-item-entity";
import {
  MAX_WAITING_ON_WALK,
  workItemPeopleUserIds,
  workItemWaitingOnUserIds,
} from "../domain/work-item-waiting-on";
import type { WorkItemRepo } from "./work-item-repo";

/**
 * `workItemWaitingOnUserIds` for `workItem`, loading its parents one at a
 * time only while none so far has an assignee or creator. An item with
 * either costs no extra read.
 */
export const loadWorkItemWaitingOnUserIds = async (
  workItem: WorkItemEntity | null,
  triggeredByUserId: UuidV7 | null | undefined,
  workItemRepo: Pick<WorkItemRepo, "load">,
  dbExecutor: DbExecutor,
): Promise<UuidV7[]> => {
  const chain: WorkItemEntity[] = [];
  const seen = new Set<string>();
  let current = workItem;
  while (
    current &&
    !seen.has(current.id) &&
    chain.length < MAX_WAITING_ON_WALK
  ) {
    chain.push(current);
    seen.add(current.id);
    if (
      workItemPeopleUserIds(current).length > 0 ||
      !current.parentWorkItemId
    ) {
      break;
    }
    current = await workItemRepo.load(current.parentWorkItemId, dbExecutor);
  }
  return workItemWaitingOnUserIds(chain, triggeredByUserId);
};

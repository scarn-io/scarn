import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { WorkItemEventsPort } from "@scarn/core/work-items/work-item/application/work-item-events-port";
import type { WorkItemBlockRepo } from "./work-item-block-repo";
import {
  deleteWorkItemBlockInputSchema,
  type DeleteWorkItemBlockInput,
} from "../contracts/work-item-block-contracts";
import { parseWorkItemBlockId } from "../domain/work-item-block-id";

type DeleteWorkItemBlockDeps = {
  userAuthz: UserAuthorizationService;
  workItemBlockRepo: WorkItemBlockRepo;
  workItemEvents: WorkItemEventsPort;
  dbExecutor?: DbExecutor | undefined;
};

/**
 * The one front door for removing a block. Tells `workItemEvents` about
 * the blocked item in the same transaction (its caller's, or its own).
 */
export const deleteWorkItemBlock = async (
  input: DeleteWorkItemBlockInput,
  deps: DeleteWorkItemBlockDeps,
): Promise<number> => {
  if (!deps.dbExecutor) {
    return await getDb().transaction(
      async (tx) =>
        await deleteWorkItemBlock(input, { ...deps, dbExecutor: tx }),
    );
  }
  const { userAuthz, workItemBlockRepo, workItemEvents, dbExecutor } = deps;
  const blockId = parseWorkItemBlockId(
    deleteWorkItemBlockInputSchema.parse(input),
  );

  const block = await workItemBlockRepo.load(blockId, dbExecutor);
  if (!block) {
    throw new ResourceNotFoundError("Work item block", blockId);
  }

  await userAuthz.requireProjectPermission({
    projectId: block.projectId,
    permission: "work-items:update",
    dbExecutor,
  });

  const deleted = await workItemBlockRepo.delete(blockId, dbExecutor);
  await workItemEvents.mayHaveBecomeReady(
    [block.blockedWorkItemId],
    dbExecutor,
  );
  return deleted;
};

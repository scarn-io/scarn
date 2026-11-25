import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { WorkItemEventsPort } from "@scarn/core/work-items/work-item/application/work-item-events-port";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { WorkItemRepo } from "@scarn/core/work-items/work-item/application/work-item-repo";
import { parseWorkItemId } from "@scarn/core/work-items/work-item/domain/work-item-id";
import {
  createWorkItemBlockInputToProps,
  workItemBlockEntityToContract,
} from "./work-item-block-contract-mapper";
import { validateWorkItemBlockCandidate } from "./validate-work-item-block";
import type { WorkItemBlockRepo } from "./work-item-block-repo";
import {
  createWorkItemBlockInputSchema,
  type CreateWorkItemBlockInput,
  type WorkItemBlockContract,
} from "../contracts/work-item-block-contracts";
import { WorkItemBlockEntity } from "../domain/work-item-block-entity";

export type CreateWorkItemBlockDeps = {
  userAuthz: UserAuthorizationService;
  workItemRepo: WorkItemRepo;
  workItemBlockRepo: WorkItemBlockRepo;
  workItemEvents: WorkItemEventsPort;
  timeProvider: TimeProvider;
  dbExecutor?: DbExecutor | undefined;
};

/**
 * The one front door for adding a block. Tells `workItemEvents` about
 * the blocked item in the same transaction (its caller's, or its own).
 */
export const createWorkItemBlock = async (
  input: CreateWorkItemBlockInput,
  deps: CreateWorkItemBlockDeps,
): Promise<WorkItemBlockContract> => {
  if (!deps.dbExecutor) {
    return await getDb().transaction(
      async (tx) =>
        await createWorkItemBlock(input, { ...deps, dbExecutor: tx }),
    );
  }
  const {
    userAuthz,
    workItemRepo,
    workItemBlockRepo,
    workItemEvents,
    timeProvider,
    dbExecutor,
  } = deps;
  const parsedInput = createWorkItemBlockInputSchema.parse(input);
  const blockedWorkItemId = parseWorkItemId(parsedInput.blockedWorkItemId);
  const blockingWorkItemId = parseWorkItemId(parsedInput.blockingWorkItemId);

  const loadedWorkItems = await workItemRepo.loadMany(
    [blockedWorkItemId, blockingWorkItemId],
    dbExecutor,
  );
  const blockedWorkItem = loadedWorkItems.find(
    (item) => item.id === blockedWorkItemId,
  );
  if (!blockedWorkItem) {
    throw new ResourceNotFoundError("Work item", blockedWorkItemId);
  }

  // Permission is checked against the blocked item's project. If the
  // blocking item turns out to live in a different project, that is rejected
  // below as `WORK_ITEM_BLOCK_CROSS_PROJECT` — this check runs first only
  // because it needs a resolved `projectId` and the blocked item is always
  // present.
  await userAuthz.requireProjectPermission({
    projectId: blockedWorkItem.projectId,
    permission: "work-items:write",
    dbExecutor,
  });

  const blockingWorkItem = loadedWorkItems.find(
    (item) => item.id === blockingWorkItemId,
  );
  if (!blockingWorkItem) {
    throw new ResourceNotFoundError("Work item", blockingWorkItemId);
  }

  await validateWorkItemBlockCandidate(blockedWorkItem, blockingWorkItem, {
    workItemBlockRepo,
    dbExecutor,
  });

  const now = timeProvider.now();
  const block = WorkItemBlockEntity.rehydrate({
    ...WorkItemBlockEntity.create(
      createWorkItemBlockInputToProps(parsedInput, {
        projectId: blockedWorkItem.projectId,
        createdByUserId: userAuthz.actorId,
      }),
    ).toJSON(),
    createdAt: now,
  });

  const persisted = await workItemBlockRepo.create(block, dbExecutor);
  await workItemEvents.mayHaveBecomeReady(
    [persisted.blockedWorkItemId],
    dbExecutor,
  );
  return workItemBlockEntityToContract(persisted);
};

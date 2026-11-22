import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import { validateAndSetWorkItemParent } from "./validate-work-item-parent";
import { workItemEntityToContract } from "./work-item-contract-mapper";
import type { WorkItemRepo } from "./work-item-repo";
import {
  setWorkItemParentInputSchema,
  type SetWorkItemParentInput,
  type WorkItemContract,
} from "../contracts/work-item-contracts";
import type { WorkItemEntity } from "../domain/work-item-entity";
import { parseWorkItemId } from "../domain/work-item-id";

type SetWorkItemParentDeps = {
  userAuthz: UserAuthorizationService;
  workItemRepo: WorkItemRepo;
  usernameReader: UsernameReader;
  timeProvider: TimeProvider;
  dbExecutor?: DbExecutor | undefined;
};

export const setWorkItemParent = async (
  input: SetWorkItemParentInput,
  deps: SetWorkItemParentDeps,
): Promise<WorkItemContract> => {
  const { userAuthz, workItemRepo, usernameReader, timeProvider, dbExecutor } =
    deps;
  const parsedInput = setWorkItemParentInputSchema.parse(input);
  const workItemId = parseWorkItemId(parsedInput.workItemId);
  const parentWorkItemId = parsedInput.parentWorkItemId
    ? parseWorkItemId(parsedInput.parentWorkItemId)
    : null;

  const idsToLoad = parentWorkItemId
    ? [workItemId, parentWorkItemId]
    : [workItemId];
  const loadedWorkItems = await workItemRepo.loadMany(idsToLoad, dbExecutor);
  const workItem = loadedWorkItems.find((item) => item.id === workItemId);
  if (!workItem) {
    throw new ResourceNotFoundError("Work item", workItemId);
  }

  await userAuthz.requireProjectPermission({
    projectId: workItem.projectId,
    permission: "work-items:update",
    dbExecutor,
  });

  let parentWorkItem: WorkItemEntity | null = null;
  if (parentWorkItemId) {
    parentWorkItem =
      loadedWorkItems.find((item) => item.id === parentWorkItemId) ?? null;
    if (!parentWorkItem) {
      throw new ResourceNotFoundError("Work item", parentWorkItemId);
    }
  }

  const reparented = await validateAndSetWorkItemParent(
    workItem,
    parentWorkItem,
    { workItemRepo, dbExecutor },
    timeProvider.now(),
  );
  const persisted = await workItemRepo.save(reparented, dbExecutor);

  const creatorsByUserId = await usernameReader.loadUsernamesByUserId(
    persisted.createdByUserId === null ? [] : [persisted.createdByUserId],
    dbExecutor,
  );
  const creator = persisted.createdByUserId
    ? creatorsByUserId.get(persisted.createdByUserId)
    : undefined;

  return workItemEntityToContract(
    persisted,
    creator?.username ?? null,
    creator?.image ?? null,
  );
};

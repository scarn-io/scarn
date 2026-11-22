import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import { workItemEntityToContract } from "./work-item-contract-mapper";
import type { WorkItemRepo } from "./work-item-repo";
import {
  getWorkItemInputSchema,
  type GetWorkItemInput,
  type WorkItemContract,
} from "../contracts/work-item-contracts";
import { parseWorkItemId } from "../domain/work-item-id";

type GetWorkItemDeps = {
  userAuthz: UserAuthorizationService;
  workItemRepo: WorkItemRepo;
  usernameReader: UsernameReader;
  dbExecutor?: DbExecutor;
};

export const getWorkItem = async (
  input: GetWorkItemInput,
  { userAuthz, workItemRepo, usernameReader, dbExecutor }: GetWorkItemDeps,
): Promise<Result<WorkItemContract, ResourceNotFoundError>> => {
  const workItemId = parseWorkItemId(getWorkItemInputSchema.parse(input));

  const workItem = await workItemRepo.load(workItemId, dbExecutor);
  if (!workItem) {
    return Result.err(new ResourceNotFoundError("Work item", workItemId));
  }

  await userAuthz.requireProjectPermission({
    projectId: workItem.projectId,
    permission: "work-items:read",
    dbExecutor,
  });

  // Resolve the creator id → display fields at read time. The id stays the
  // identity of record; username + image are never persisted on the work item.
  const creatorsByUserId = await usernameReader.loadUsernamesByUserId(
    workItem.createdByUserId === null ? [] : [workItem.createdByUserId],
    dbExecutor,
  );
  const creator = workItem.createdByUserId
    ? creatorsByUserId.get(workItem.createdByUserId)
    : undefined;

  return Result.ok(
    workItemEntityToContract(
      workItem,
      creator?.username ?? null,
      creator?.image ?? null,
    ),
  );
};

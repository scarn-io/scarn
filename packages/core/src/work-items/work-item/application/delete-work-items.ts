import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { WorkItemRepo } from "./work-item-repo";
import {
  deleteWorkItemInputSchema,
  deleteWorkItemsInputSchema,
  type DeleteWorkItemInput,
  type DeleteWorkItemsInput,
} from "../contracts/work-item-contracts";
import { parseWorkItemId } from "../domain/work-item-id";

type DeleteWorkItemsDeps = {
  userAuthz: UserAuthorizationService;
  workItemRepo: WorkItemRepo;
  dbExecutor?: DbExecutor;
};

const loadRequiredWorkItems = async (
  input: DeleteWorkItemsInput,
  {
    workItemRepo,
    dbExecutor,
  }: {
    workItemRepo: WorkItemRepo;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<Awaited<ReturnType<WorkItemRepo["loadMany"]>>, ResourceNotFoundError>> => {
  const parsedInput = deleteWorkItemsInputSchema.parse(input);
  const workItemIds = parsedInput.map((workItemId) => parseWorkItemId(workItemId));
  const workItems = await workItemRepo.loadMany(workItemIds, dbExecutor);
  const workItemById = new Map(workItems.map((workItem) => [workItem.id, workItem]));

  const result: Awaited<ReturnType<WorkItemRepo["loadMany"]>> = [];
  for (const workItemId of workItemIds) {
    const workItem = workItemById.get(workItemId);

    if (!workItem) {
      return Result.err(new ResourceNotFoundError("Work item", workItemId));
    }

    result.push(workItem);
  }
  return Result.ok(result);
};

const requireDeleteWorkItemsProjectPermission = async (
  input: DeleteWorkItemsInput,
  { userAuthz, workItemRepo, dbExecutor }: DeleteWorkItemsDeps,
): Promise<Result<void, ResourceNotFoundError>> => {
  const workItemsResult = await loadRequiredWorkItems(input, { workItemRepo, dbExecutor });
  if (!workItemsResult.ok) return workItemsResult;
  const projectIds = [...new Set(workItemsResult.value.map((workItem) => workItem.projectId))];

  for (const projectId of projectIds) {
    await userAuthz.requireProjectPermission({
      projectId,
      permission: "work-items:delete",
      dbExecutor,
    });
  }
  return Result.ok(undefined);
};

const executeDeleteWorkItems = async (
  input: DeleteWorkItemsInput,
  { workItemRepo, dbExecutor }: DeleteWorkItemsDeps,
): Promise<number> => {
  const parsedInput = deleteWorkItemsInputSchema.parse(input);
  const workItemIds = parsedInput.map((workItemId) => parseWorkItemId(workItemId));

  return await workItemRepo.deleteMany(workItemIds, dbExecutor);
};

export const deleteWorkItems = async (
  input: DeleteWorkItemsInput,
  deps: DeleteWorkItemsDeps,
): Promise<Result<number, ResourceNotFoundError>> => {
  const permResult = await requireDeleteWorkItemsProjectPermission(input, deps);
  if (!permResult.ok) return permResult;
  return Result.ok(await executeDeleteWorkItems(input, deps));
};

export const deleteWorkItem = async (
  input: DeleteWorkItemInput,
  deps: DeleteWorkItemsDeps,
): Promise<Result<number, ResourceNotFoundError>> => {
  const parsedInput = deleteWorkItemInputSchema.parse(input);
  return await deleteWorkItems([parsedInput], deps);
};

import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { WorkItemRepo } from "@scarn/core/work-items/work-item/application/work-item-repo";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { parseWorkItemId } from "@scarn/core/work-items/work-item/domain/work-item-id";
import {
  listWorkItemActivityInputSchema,
  type ListWorkItemActivityInput,
  type WorkItemActivityEntryContract,
} from "../contracts/work-item-activity-contracts";
import type { WorkItemActivityRepo } from "./work-item-activity-repo";

type ListWorkItemActivityDeps = {
  userAuthz: UserAuthorizationService;
  workItemRepo: WorkItemRepo;
  workItemActivityRepo: WorkItemActivityRepo;
  dbExecutor?: DbExecutor | undefined;
};

/** `GET /work-items/:workItemId/activity`: the work item's activity, oldest first. */
export const listWorkItemActivity = async (
  input: ListWorkItemActivityInput,
  deps: ListWorkItemActivityDeps,
): Promise<WorkItemActivityEntryContract[]> => {
  const workItemId = parseWorkItemId(
    listWorkItemActivityInputSchema.parse(input),
  );
  const workItem = await deps.workItemRepo.load(workItemId, deps.dbExecutor);
  if (!workItem) {
    throw new ResourceNotFoundError("Work item", workItemId);
  }
  await deps.userAuthz.requireProjectPermission({
    projectId: workItem.projectId,
    permission: "work-items:read",
    dbExecutor: deps.dbExecutor,
  });
  const entries = await deps.workItemActivityRepo.listByWorkItemId(
    workItemId,
    deps.dbExecutor,
  );
  return entries.map((entry) => ({
    id: entry.id,
    workItemId: parseUuidV7(entry.workItemId),
    kind: entry.kind,
    message: entry.message,
    createdAt: entry.createdAt.toISOString(),
  }));
};

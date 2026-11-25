import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { WorkItemRepo } from "@scarn/core/work-items/work-item/application/work-item-repo";
import { parseWorkItemId } from "@scarn/core/work-items/work-item/domain/work-item-id";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { workItemBlockEntityToContract } from "./work-item-block-contract-mapper";
import type { WorkItemBlockRepo } from "./work-item-block-repo";
import {
  listWorkItemBlocksInputSchema,
  type ListWorkItemBlocksInput,
  type ListWorkItemBlocksResult,
} from "../contracts/work-item-block-contracts";

type ListWorkItemBlocksDeps = {
  userAuthz: UserAuthorizationService;
  workItemRepo: WorkItemRepo;
  workItemBlockRepo: WorkItemBlockRepo;
  dbExecutor?: DbExecutor | undefined;
};

// `work-items:read` (the sibling read permission to the `work-items:write`
// required to create/delete blocks — see `docs/apis.md`'s `<resource>:<action>`
// vocabulary in `project-permission.ts`) rather than `comments:read`: this is
// data about work items, not comments, and Decision 11 of
// `docs/work-item-relationships-plan.md` only pins down the *write* side
// (reuse `work-items:write`, no new permission) — it does not name a read
// permission, so the natural sibling of the resource being read is used.
export const listWorkItemBlocks = async (
  input: ListWorkItemBlocksInput,
  deps: ListWorkItemBlocksDeps,
): Promise<ListWorkItemBlocksResult> => {
  const { userAuthz, workItemRepo, workItemBlockRepo, dbExecutor } = deps;
  const workItemId = parseWorkItemId(
    listWorkItemBlocksInputSchema.parse(input),
  );

  const workItem = await workItemRepo.load(workItemId, dbExecutor);
  if (!workItem) {
    throw new ResourceNotFoundError("Work item", workItemId);
  }

  await userAuthz.requireProjectPermission({
    projectId: workItem.projectId,
    permission: "work-items:read",
    dbExecutor,
  });

  const workItemUuid = parseUuidV7(workItemId);
  const blocks = await workItemBlockRepo.listByWorkItem(
    workItemUuid,
    dbExecutor,
  );

  const blockedBy = blocks
    .filter((block) => block.blockedWorkItemId === workItemUuid)
    .map(workItemBlockEntityToContract);
  const blocking = blocks
    .filter((block) => block.blockingWorkItemId === workItemUuid)
    .map(workItemBlockEntityToContract);

  return { blockedBy, blocking };
};

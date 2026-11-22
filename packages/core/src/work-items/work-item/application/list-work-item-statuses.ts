import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { getProjectInputSchema } from "@scarn/core/projects/project/contracts/project-contracts";
import { assertProjectPermission } from "@scarn/core/projects/project/application/project-authorization";
import type { ProjectRepo } from "@scarn/core/projects/project/application/project-repo";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { TaskRepo } from "@scarn/core/tasks/task/application/task-repo";
import type { WorkItemBlockRepo } from "@scarn/core/work-items/work-item-block/application/work-item-block-repo";
import type { WorkItemRepo } from "./work-item-repo";
import {
  MAX_WORK_ITEM_STATUS_IDS,
  type WorkItemStatusSummaryContract,
} from "../contracts/child-work-item-contracts";
import { childWorkItemStatus } from "../domain/child-work-item-status";
import { isWorkItemId, type WorkItemId } from "../domain/work-item-id";

type ListWorkItemStatusesDeps = {
  userAuthz: UserAuthorizationService;
  projectRepo: ProjectRepo;
  workItemRepo: Pick<WorkItemRepo, "loadMany">;
  taskRepo: Pick<TaskRepo, "loadLatestStatusByWorkItemIds">;
  workItemBlockRepo: Pick<WorkItemBlockRepo, "listOpenBlockerIdsByBlocked">;
  dbExecutor?: DbExecutor | undefined;
};

/**
 * The live title and status of each of `ids` that is a work item in the
 * project, in the order asked. Ids that aren't UUID v7s, don't exist (or
 * were deleted) or belong to another project are left out, so a caller
 * can't learn anything about items outside the project. Reads the items,
 * their newest Tasks and their open blockers in one query each. Gated on
 * `work-items:read`, like the listing.
 */
export const listWorkItemStatuses = async (
  input: { projectId: string; ids: readonly string[] },
  {
    userAuthz,
    projectRepo,
    workItemRepo,
    taskRepo,
    workItemBlockRepo,
    dbExecutor,
  }: ListWorkItemStatusesDeps,
): Promise<Result<WorkItemStatusSummaryContract[], ResourceNotFoundError>> => {
  const projectId = parseUuidV7(getProjectInputSchema.parse(input.projectId));
  const project = await projectRepo.load(projectId, dbExecutor);
  if (!project) {
    return Result.err(new ResourceNotFoundError("Project", projectId));
  }
  assertProjectPermission(project, userAuthz.actorId, "work-items:read");

  const ids: WorkItemId[] = [
    ...new Set(input.ids.map((id) => id.trim()).filter(isWorkItemId)),
  ].slice(0, MAX_WORK_ITEM_STATUS_IDS);
  if (ids.length === 0) {
    return Result.ok([]);
  }

  const items = (await workItemRepo.loadMany(ids, dbExecutor)).filter(
    (item) => item.projectId === projectId,
  );
  const itemIds = items.map((item) => parseUuidV7(item.id));
  const [latestTaskStatuses, openBlockerIds] = await Promise.all([
    taskRepo.loadLatestStatusByWorkItemIds(itemIds, dbExecutor),
    workItemBlockRepo.listOpenBlockerIdsByBlocked(itemIds, dbExecutor),
  ]);

  const byId = new Map(items.map((item) => [item.id as string, item]));
  return Result.ok(
    ids.flatMap((id) => {
      const item = byId.get(id);
      if (!item) return [];
      const key = parseUuidV7(item.id);
      return [
        {
          id: key,
          title: item.title,
          status: childWorkItemStatus({
            state: item.state,
            hasOpenBlockers: (openBlockerIds.get(key) ?? []).length > 0,
            latestTaskStatus: latestTaskStatuses.get(key) ?? null,
          }),
        },
      ];
    }),
  );
};

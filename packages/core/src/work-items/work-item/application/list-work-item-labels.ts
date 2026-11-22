import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { getProjectInputSchema } from "@scarn/core/projects/project/contracts/project-contracts";
import { assertProjectPermission } from "@scarn/core/projects/project/application/project-authorization";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { ProjectRepo } from "@scarn/core/projects/project/application/project-repo";
import type { WorkItemRepo } from "./work-item-repo";

type ListWorkItemLabelsDeps = {
  userAuthz: UserAuthorizationService;
  projectRepo: ProjectRepo;
  workItemRepo: WorkItemRepo;
  dbExecutor?: DbExecutor | undefined;
};

/**
 * The distinct labels on a project's work items, for label suggestions and
 * the label filter. Gated on `work-items:read`, like the listing.
 */
export const listWorkItemLabels = async (
  input: string,
  { userAuthz, projectRepo, workItemRepo, dbExecutor }: ListWorkItemLabelsDeps,
): Promise<Result<string[], ResourceNotFoundError>> => {
  const projectId = parseUuidV7(getProjectInputSchema.parse(input));

  const project = await projectRepo.load(projectId, dbExecutor);
  if (!project) {
    return Result.err(new ResourceNotFoundError("Project", projectId));
  }
  assertProjectPermission(project, userAuthz.actorId, "work-items:read");

  return Result.ok(await workItemRepo.listLabels(projectId, dbExecutor));
};

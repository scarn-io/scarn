import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { getProjectInputSchema } from "@scarn/core/projects/project/contracts/project-contracts";
import { assertProjectPermission } from "@scarn/core/projects/project/application/project-authorization";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { WorkItemRepo } from "./work-item-repo";
import type { ProjectRepo } from "@scarn/core/projects/project/application/project-repo";
import type { WorkItemFieldOptionContract } from "../contracts/work-item-contracts";

type ListWorkItemFieldOptionsDeps = {
  userAuthz: UserAuthorizationService;
  projectRepo: ProjectRepo;
  workItemRepo: WorkItemRepo;
  dbExecutor?: DbExecutor | undefined;
};

/**
 * Distinct scalar `fields` keys and values across a project, for populating the
 * filter dropdowns. Deliberately independent of any active filter and of the
 * requested page, so the options do not collapse as the user narrows down.
 *
 * Gated on the same `work-items:read` permission as the listing itself.
 */
export const listWorkItemFieldOptions = async (
  input: string,
  {
    userAuthz,
    projectRepo,
    workItemRepo,
    dbExecutor,
  }: ListWorkItemFieldOptionsDeps,
): Promise<Result<WorkItemFieldOptionContract[], ResourceNotFoundError>> => {
  const projectId = parseUuidV7(getProjectInputSchema.parse(input));

  // Authorization + existence gate only; see `listWorkItemsByProject` for why
  // this loads the project directly rather than going through `getProject`.
  const project = await projectRepo.load(projectId, dbExecutor);
  if (!project) {
    return Result.err(new ResourceNotFoundError("Project", projectId));
  }
  assertProjectPermission(project, userAuthz.actorId, "work-items:read");

  return Result.ok(await workItemRepo.listFieldOptions(projectId, dbExecutor));
};

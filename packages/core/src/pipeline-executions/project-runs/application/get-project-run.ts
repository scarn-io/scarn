import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { ProjectRepo } from "@scarn/core/projects/project/application/project-repo";
import {
  getProjectRunParamsSchema,
  type ProjectRunContract,
} from "../contracts/project-runs-contracts";
import {
  hydrateProjectRuns,
  type HydrateProjectRunsDeps,
} from "./hydrate-project-runs";

export type GetProjectRunDeps = HydrateProjectRunsDeps & {
  userAuthz: UserAuthorizationService;
  projectRepo: Pick<ProjectRepo, "load">;
};

/**
 * One row of the project's Runs list, derived exactly as the list derives it,
 * for a run's own page header. `type` is `pipeline` or `task` (a single
 * step, a prompt Task or a Task without a work item). Same access as the
 * list. 404 for an unknown
 * project, or when the id is not a row of that kind (a Task owned by a node
 * visit is not a row).
 */
export const getProjectRun = async (
  input: { projectId: string; type: string; id: string },
  deps: GetProjectRunDeps,
): Promise<Result<ProjectRunContract, ResourceNotFoundError>> => {
  const params = getProjectRunParamsSchema.parse(input);
  const projectId = parseUuidV7(params.projectId);
  const id = parseUuidV7(params.id);
  const { type } = params;
  const project = await deps.projectRepo.load(projectId, deps.dbExecutor);
  if (!project) {
    return Result.err(new ResourceNotFoundError("Project", projectId));
  }
  const grant = await deps.userAuthz.requireProjectPermission({
    projectId,
    permission: "executions:read",
    dbExecutor: deps.dbExecutor,
  });
  const viewerUserId = grant.membership ? deps.userAuthz.actorId : null;
  const key = await deps.projectRunsReader.findKey(
    { projectId, viewerUserId, actorUserId: deps.userAuthz.actorId },
    type,
    id,
    deps.dbExecutor,
  );
  const [run] = key ? await hydrateProjectRuns([key], viewerUserId, deps) : [];
  return run
    ? Result.ok(run)
    : Result.err(new ResourceNotFoundError("Run", id));
};

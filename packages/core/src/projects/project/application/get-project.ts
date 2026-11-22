import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { OrgRepo } from "@scarn/core/organizations/organization/application/org-repo";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import { projectEntityToContract } from "./project-contract-mapper";
import { resolveProjectOwnerUsernames } from "./resolve-project-owner-usernames";
import { assertProjectPermission } from "./project-authorization";
import type { ProjectRepo } from "./project-repo";
import {
  getProjectInputSchema,
  type GetProjectInput,
  type ProjectContract,
} from "../contracts/project-contracts";

export const getProject = async (
  input: GetProjectInput,
  {
    userAuthz,
    projectRepo,
    orgRepo,
    usernameReader,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    projectRepo: ProjectRepo;
    orgRepo: OrgRepo;
    usernameReader: UsernameReader;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<ProjectContract, ResourceNotFoundError>> => {
  const projectId = parseUuidV7(getProjectInputSchema.parse(input));
  const project = await projectRepo.load(projectId, dbExecutor);

  if (!project) {
    return Result.err(new ResourceNotFoundError("Project", projectId));
  }

  assertProjectPermission(project, userAuthz.actorId, "work-items:read");

  const ownerUsernameByProjectId = await resolveProjectOwnerUsernames(
    [project],
    { orgRepo, usernameReader, dbExecutor },
  );

  return Result.ok(
    projectEntityToContract(
      project,
      ownerUsernameByProjectId.get(project.id) ?? null,
    ),
  );
};

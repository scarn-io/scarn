import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { OrgRepo } from "@scarn/core/organizations/organization/application/org-repo";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import { projectEntityToContract } from "./project-contract-mapper";
import { resolveProjectOwnerUsernames } from "./resolve-project-owner-usernames";
import type { ProjectRepo } from "./project-repo";
import type { ProjectContract } from "../contracts/project-contracts";

export const listProjects = async ({
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
}): Promise<ProjectContract[]> => {
  const projects = await projectRepo.listByUser(userAuthz.actorId, dbExecutor);
  // Resolve every project's OWNER username at read time (owning org → owner
  // user id → username), batched into one org lookup + one username lookup, so
  // a viewer's links to another user's shared project use the OWNER's username.
  const ownerUsernameByProjectId = await resolveProjectOwnerUsernames(
    projects,
    { orgRepo, usernameReader, dbExecutor },
  );
  return projects.map((project) =>
    projectEntityToContract(
      project,
      ownerUsernameByProjectId.get(project.id) ?? null,
    ),
  );
};

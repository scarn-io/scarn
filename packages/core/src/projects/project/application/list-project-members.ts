import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { CoreError, ResourceNotFoundError } from "@scarn/core/lib/errors";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import { assertProjectPermission } from "./project-authorization";
import type { ProjectRepo } from "./project-repo";
import {
  getProjectInputSchema,
  type GetProjectInput,
  type ProjectMemberContract,
} from "../contracts/project-contracts";

/**
 * The project's members with their display fields, role and resolved
 * permissions, ordered by username. Members
 * only: a public project's read grant to non-members isn't enough, since the
 * list exists to pick a teammate (e.g. a work item assignee).
 */
export const listProjectMembers = async (
  input: GetProjectInput,
  {
    userAuthz,
    projectRepo,
    usernameReader,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    projectRepo: Pick<ProjectRepo, "load">;
    usernameReader: UsernameReader;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<ProjectMemberContract[]> => {
  const projectId = parseUuidV7(getProjectInputSchema.parse(input));
  const project = await projectRepo.load(projectId, dbExecutor);
  if (!project) {
    throw new ResourceNotFoundError("Project", projectId);
  }

  const grant = assertProjectPermission(
    project,
    userAuthz.actorId,
    "work-items:read",
  );
  if (!grant.membership) {
    throw new CoreError({
      code: "PROJECT_FORBIDDEN",
      message: "You are not a member of this project",
      status: 403,
      meta: { permission: "work-items:read" },
    });
  }

  const displays = await usernameReader.loadUsernamesByUserId(
    project.memberships.map((membership) => membership.userId),
    dbExecutor,
  );

  return project.memberships
    .map(({ userId, role, permissions }) => ({
      userId,
      username: displays.get(userId)?.username ?? null,
      image: displays.get(userId)?.image ?? null,
      role,
      permissions: [...permissions],
    }))
    .sort((a, b) =>
      (a.username ?? "\uffff").localeCompare(b.username ?? "\uffff"),
    );
};

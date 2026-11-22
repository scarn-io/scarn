import { CoreError, ResourceNotFoundError } from "@scarn/core/lib/errors";
import type { ProjectRepo } from "@scarn/core/projects/project/application/project-repo";
import type { ProjectPermission } from "@scarn/core/projects/project/domain/project-permission";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { ProjectMembership } from "@scarn/core/projects/project/domain/project-membership";
import { SYSTEM_ACTOR_ID } from "../system-actor";
import type {
  UserAuthorizationService,
  RequireProjectPermissionInput,
  ProjectPermissionGrant,
} from "../application/user-authorization-service";

export { SYSTEM_ACTOR_ID };

// The only permissions the system actor is allowed to exercise. Kept narrow
// and reviewed deliberately: this actor runs unattended, with no human in the
// loop, so its blast radius must stay small and explicit.
//
// `executions:write` is required because an automation's pipeline target
// creates a pipeline execution as a side effect of a work item change — it
// does not grant any other execution-lifecycle permission (e.g.
// start/cancel/advance), which the system actor never drives.
const SYSTEM_ACTOR_ALLOWED_PERMISSIONS: ReadonlySet<ProjectPermission> =
  new Set<ProjectPermission>([
    "work-items:write",
    "work-items:update",
    "executions:write",
  ]);

/**
 * Authorization service for the synthetic system actor used by unattended
 * background flows (e.g. scheduled reconciliation). Unlike
 * `ProjectAuthorizationService`, permission is not derived from project
 * membership — it is granted purely from a fixed allowlist, since the system
 * actor is never a project member.
 *
 * Still checks project existence, for parity with `ProjectAuthorizationService`
 * and so callers get a consistent `ResourceNotFoundError` when the target
 * project does not exist.
 */
export class SystemAuthorizationService implements UserAuthorizationService {
  public readonly actorId: UuidV7 = SYSTEM_ACTOR_ID;

  public constructor(private readonly projectRepo: ProjectRepo) {}

  public async requireProjectPermission({
    projectId,
    permission,
    dbExecutor,
  }: RequireProjectPermissionInput): Promise<ProjectPermissionGrant> {
    const project = await this.projectRepo.load(projectId, dbExecutor);

    if (!project) {
      throw new ResourceNotFoundError("Project", projectId);
    }

    if (!SYSTEM_ACTOR_ALLOWED_PERMISSIONS.has(permission)) {
      throw new CoreError({
        code: "PROJECT_FORBIDDEN",
        message: `The system actor does not have the ${permission} permission on this project`,
        status: 403,
        meta: { permission },
      });
    }

    return { membership: null, isPublicNonMemberGrant: false };
  }

  /** The system actor is never a project member. */
  public async requireProjectMember(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectMembership> {
    const project = await this.projectRepo.load(projectId, dbExecutor);

    if (!project) {
      throw new ResourceNotFoundError("Project", projectId);
    }

    throw new CoreError({
      code: "PROJECT_FORBIDDEN",
      message: "The system actor is not a member of this project",
      status: 403,
    });
  }
}

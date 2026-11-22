import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { ProjectPermission } from "@scarn/core/projects/project/domain/project-permission";
import type { ProjectMembership } from "@scarn/core/projects/project/domain/project-membership";

export type RequireProjectPermissionInput = {
  projectId: UuidV7;
  permission: ProjectPermission;
  dbExecutor?: DbExecutor | undefined;
};

/**
 * The outcome of a successful `requireProjectPermission` check. Distinct from
 * a bare "granted" boolean because callers that touch metered object storage
 * (log archives, artifacts) need to know *why* access was granted:
 * `isPublicNonMemberGrant` is true exactly when the permission was satisfied
 * by `ProjectEntity.visibility === "public"` rather than by an explicit
 * membership row, and those reads must be excluded from the owning org's
 * usage-quota accounting.
 */
export type ProjectPermissionGrant = {
  membership: ProjectMembership | null;
  isPublicNonMemberGrant: boolean;
};

export interface UserAuthorizationService {
  readonly actorId: UuidV7;
  requireProjectPermission(
    input: RequireProjectPermissionInput,
  ): Promise<ProjectPermissionGrant>;
  /**
   * Requires the actor to hold a membership row on the project, whatever its
   * permissions. Unlike `requireProjectPermission` there is no public-project
   * fallback: anonymous actors and non-members get the same 404 as a missing
   * project, so the check doesn't reveal what the project holds.
   */
  requireProjectMember(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectMembership>;
}

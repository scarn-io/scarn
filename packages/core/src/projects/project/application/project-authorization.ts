import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { CoreError } from "@scarn/core/lib/errors";
import { ANONYMOUS_ACTOR_ID } from "@scarn/core/access/authorization/anonymous-actor";
import type { ProjectPermissionGrant } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { ProjectEntity } from "../domain/project-entity";
import {
  hasProjectPermission,
  isReadProjectPermission,
  type ProjectPermission,
} from "../domain/project-permission";

/**
 * The grant-resolution rules shared by `assertProjectPermission` and
 * `resolveProjectPermissionGrant`:
 *
 * 1. An explicit membership grant always wins (member + has the permission).
 * 2. Failing that, a `:read` permission on a `visibility: "public"` project
 *    is granted to ANY actor — member or not, anonymous or authenticated —
 *    without a membership row. Write permissions never fall back this way,
 *    even on a public project.
 */
const resolvePermissionGrant = (
  project: ProjectEntity,
  userId: UuidV7,
  permission: ProjectPermission,
): ProjectPermissionGrant | null => {
  const membership = project.getMembership(userId);

  if (membership && hasProjectPermission(membership.permissions, permission)) {
    return { membership, isPublicNonMemberGrant: false };
  }

  if (project.visibility === "public" && isReadProjectPermission(permission)) {
    // A real member (even one lacking this exact permission) is granted here
    // too, but is deliberately NEVER flagged as a public non-member grant:
    // their reads are real project activity from an actual team member and
    // must still count toward the owning org's own quota. Only a caller with
    // no membership row at all — anonymous or a logged-in stranger — gets the
    // quota exemption (see `ProjectPermissionGrant.isPublicNonMemberGrant`).
    return { membership, isPublicNonMemberGrant: !membership };
  }

  return null;
};

/**
 * Non-throwing counterpart to `assertProjectPermission`, for call sites that
 * need a permission check to gate behavior (drop a param, zero out a count)
 * rather than reject the request. `list-work-items-by-project.ts` uses this
 * for its `comments:read` gate on `awaitingApproval` (decisions 13/14 of
 * `docs/plans/awaiting-approval-filter.md`): a caller lacking that permission
 * still gets a 200, just with the filter silently ignored, so a hard 403
 * would be the wrong shape here.
 */
export const resolveProjectPermissionGrant = (
  project: ProjectEntity,
  userId: UuidV7,
  permission: ProjectPermission,
): ProjectPermissionGrant | null =>
  resolvePermissionGrant(project, userId, permission);

/**
 * The single choke point every project-scoped permission check runs through.
 *
 * Resolution order: `resolvePermissionGrant`'s two grant paths, above; failing
 * both:
 *
 * 3. The synthetic anonymous actor (no session at all) is denied with 401
 *    rather than 403: it never has a real session to be "forbidden" from, so
 *    the caller should be told to authenticate, not that it lacks permission.
 * 4. Any other actor is denied with 403, same as always.
 */
export const assertProjectPermission = (
  project: ProjectEntity,
  userId: UuidV7,
  permission: ProjectPermission,
): ProjectPermissionGrant => {
  const grant = resolvePermissionGrant(project, userId, permission);
  if (grant) {
    return grant;
  }

  if (userId === ANONYMOUS_ACTOR_ID) {
    throw new CoreError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
      status: 401,
    });
  }

  if (!project.getMembership(userId)) {
    throw new CoreError({
      code: "PROJECT_FORBIDDEN",
      message: "You are not a member of this project",
      status: 403,
      meta: { permission },
    });
  }

  throw new CoreError({
    code: "PROJECT_FORBIDDEN",
    message: `You do not have the ${permission} permission on this project`,
    status: 403,
    meta: { permission },
  });
};

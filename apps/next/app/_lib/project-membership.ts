import {
  PROJECT_ROLES,
  type ProjectContract,
} from "@scarn/api/frontend-contracts";

/**
 * Whether `userId` holds a membership row on `project` — the frontend's one
 * source of truth for "member vs. read-only viewer" (issue #150). A `null`/
 * `undefined` `userId` (no session) is never a member.
 *
 * Deliberately does not consult `project.visibility`: a public project grants
 * anonymous/non-member *reads* without a membership row (issue #149), but
 * that never makes a non-member a member — every write affordance and every
 * member-only page (context, notifications, pipelines, settings) gates on
 * this, not on visibility.
 */
export function isProjectMember(
  project: ProjectContract,
  userId: string | null | undefined,
): boolean {
  if (!userId) return false;
  return project.memberships.some((membership) => membership.userId === userId);
}

/** The display label of a project role name; unknown names show as-is. */
export function projectRoleLabel(role: string): string {
  return (
    PROJECT_ROLES.find((definition) => definition.name === role)?.label ?? role
  );
}

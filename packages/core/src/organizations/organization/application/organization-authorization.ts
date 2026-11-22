import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { CoreError } from "@scarn/core/lib/errors";
import type { OrganizationEntity } from "../domain/organization-entity";

/**
 * Authorizes that `userId` may act on `organization`.
 *
 * There is no org-level permission matrix yet (Phase 0 deliberately shipped
 * organizations WITHOUT an authorization service). The simplest correct rule for
 * a read-only billing surface is membership: any member of the org may read it.
 * This mirrors the throw-based `assertProjectPermission` shape (a 403
 * {@link CoreError}) so route handlers that `Result.unwrap` reach the global
 * error handler identically.
 *
 * FOLLOW-UP: when role-scoped org permissions land, replace the membership
 * check with a permission check (e.g. `billing:read`).
 */
export const assertOrganizationMember = (
  organization: OrganizationEntity,
  userId: UuidV7,
) => {
  const member = organization.getMember(userId);

  if (!member) {
    throw new CoreError({
      code: "ORGANIZATION_FORBIDDEN",
      message: `User ${userId} is not a member of organization ${organization.id}`,
      status: 403,
    });
  }

  return member;
};

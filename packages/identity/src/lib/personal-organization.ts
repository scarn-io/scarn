import { and, eq } from "drizzle-orm";
import { createAuthId } from "../authentication/domain/auth-id";
import type { DbExecutor } from "./db/db-executor";
import { authMembers, authOrganizations } from "./db/schema";

/**
 * Marker stored in `organization.metadata` so a user's auto-provisioned
 * "personal org" can be distinguished from orgs they later create explicitly.
 */
export const PERSONAL_ORGANIZATION_METADATA_KEY = "personal";

type PersonalOrganizationMetadata = {
  [PERSONAL_ORGANIZATION_METADATA_KEY]: true;
  ownerUserId: string;
};

export type EnsurePersonalOrganizationInput = {
  userId: string;
  userName?: string | null;
};

export type EnsurePersonalOrganizationResult = {
  organizationId: string;
  created: boolean;
};

const personalOrgName = (userName?: string | null): string => {
  const trimmed = userName?.trim();
  if (trimmed) {
    return `${trimmed}'s Organization`;
  }
  return "Personal Organization";
};

// Slugs must be globally unique. Deriving from the (already unique) user id
// guarantees uniqueness without a collision-retry loop.
const personalOrgSlug = (userId: string): string =>
  `personal-${userId.replace(/-/g, "")}`;

const buildMetadata = (userId: string): string =>
  JSON.stringify({
    [PERSONAL_ORGANIZATION_METADATA_KEY]: true,
    ownerUserId: userId,
  } satisfies PersonalOrganizationMetadata);

/**
 * Idempotently provision the single personal organization that every user
 * owns. Safe to call repeatedly (e.g. across account-linking signups): if a
 * personal org already exists for the user, it is returned unchanged.
 *
 * Lives in the identity package because better-auth owns these tables and the
 * identity package cannot depend on `@scarn/core`. App-side reads go through
 * `OrgRepo` in core.
 */
export const ensurePersonalOrganization = async (
  db: DbExecutor,
  input: EnsurePersonalOrganizationInput,
): Promise<EnsurePersonalOrganizationResult> => {
  const slug = personalOrgSlug(input.userId);

  const [existing] = await db
    .select({ id: authOrganizations.id })
    .from(authOrganizations)
    .where(eq(authOrganizations.slug, slug))
    .limit(1);

  if (existing) {
    return { organizationId: existing.id, created: false };
  }

  const organizationId = createAuthId();
  await db.insert(authOrganizations).values({
    id: organizationId,
    name: personalOrgName(input.userName),
    slug,
    metadata: buildMetadata(input.userId),
  });

  // Guard against a duplicate owner membership if this races with a retry.
  const [existingMember] = await db
    .select({ id: authMembers.id })
    .from(authMembers)
    .where(
      and(
        eq(authMembers.organizationId, organizationId),
        eq(authMembers.userId, input.userId),
      ),
    )
    .limit(1);

  if (!existingMember) {
    await db.insert(authMembers).values({
      id: createAuthId(),
      organizationId,
      userId: input.userId,
      role: "owner",
    });
  }

  return { organizationId, created: true };
};

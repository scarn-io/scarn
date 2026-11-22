import { eq, inArray } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { projects } from "@scarn/core/lib/db/schema";
import { PersistenceError } from "@scarn/core/lib/errors";
import {
  createUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import type {
  CreatePersonalOrgArgs,
  OrgRepo,
} from "../application/org-repo";
import {
  OrganizationEntity,
  type OrganizationEntityProps,
} from "../domain/organization-entity";
import type { OrganizationMemberRole } from "../contracts/organization-contracts";
import {
  identityOrganizationMembers,
  identityOrganizations,
  identityUsers,
} from "./identity-org-read-model";

type OrganizationRow = typeof identityOrganizations.$inferSelect;
type OrganizationMemberRow = typeof identityOrganizationMembers.$inferSelect;

const KNOWN_ROLES: ReadonlySet<OrganizationMemberRole> =
  new Set<OrganizationMemberRole>(["owner", "admin", "member"]);

const toMemberRole = (role: string): OrganizationMemberRole =>
  KNOWN_ROLES.has(role as OrganizationMemberRole)
    ? (role as OrganizationMemberRole)
    : "member";

// Must stay in sync with `ensurePersonalOrganization` in @scarn/identity so
// both code paths resolve the same personal-org slug for a user.
const personalOrgSlug = (userId: UuidV7): string =>
  `personal-${userId.replace(/-/g, "")}`;

const personalOrgName = (ownerName: string | null): string =>
  ownerName?.trim()
    ? `${ownerName.trim()}'s Organization`
    : "Personal Organization";

type PersonalMetadata = {
  personal?: unknown;
  ownerUserId?: unknown;
};

const parseMetadata = (metadata: string | null): PersonalMetadata => {
  if (!metadata) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(metadata);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
};

export class DrizzleOrgRepo implements OrgRepo {
  private toEntity(
    orgRow: OrganizationRow,
    memberRows: OrganizationMemberRow[],
  ): OrganizationEntity {
    const metadata = parseMetadata(orgRow.metadata);
    const isPersonal = metadata.personal === true;
    const ownerUserId =
      typeof metadata.ownerUserId === "string" ? metadata.ownerUserId : null;

    return OrganizationEntity.rehydrate({
      id: orgRow.id as OrganizationEntityProps["id"],
      name: orgRow.name,
      slug: orgRow.slug,
      isPersonal,
      ownerUserId: ownerUserId as OrganizationEntityProps["ownerUserId"],
      members: memberRows.map((memberRow) => ({
        userId: memberRow.userId as UuidV7,
        role: toMemberRole(memberRow.role),
        createdAt: memberRow.createdAt,
      })),
      createdAt: orgRow.createdAt,
    });
  }

  private async loadMembers(
    organizationId: UuidV7,
    db: DbExecutor,
  ): Promise<OrganizationMemberRow[]> {
    return await db
      .select()
      .from(identityOrganizationMembers)
      .where(eq(identityOrganizationMembers.organizationId, organizationId));
  }

  async load(
    id: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<OrganizationEntity | null> {
    const db = dbExecutor ?? getDb();
    const [orgRow] = await db
      .select()
      .from(identityOrganizations)
      .where(eq(identityOrganizations.id, id))
      .limit(1);

    if (!orgRow) {
      return null;
    }

    const memberRows = await this.loadMembers(orgRow.id as UuidV7, db);
    return this.toEntity(orgRow, memberRows);
  }

  async loadPersonalOrgByOwnerUsername(
    username: string,
    dbExecutor?: DbExecutor,
  ): Promise<OrganizationEntity | null> {
    const db = dbExecutor ?? getDb();
    const [userRow] = await db
      .select({ id: identityUsers.id })
      .from(identityUsers)
      .where(eq(identityUsers.username, username))
      .limit(1);

    if (!userRow) {
      return null;
    }

    const slug = personalOrgSlug(userRow.id as UuidV7);
    const [orgRow] = await db
      .select()
      .from(identityOrganizations)
      .where(eq(identityOrganizations.slug, slug))
      .limit(1);

    if (!orgRow) {
      return null;
    }

    const memberRows = await this.loadMembers(orgRow.id as UuidV7, db);
    return this.toEntity(orgRow, memberRows);
  }

  async loadOwnerUserIdsByOrgId(
    orgIds: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<Map<UuidV7, UuidV7>> {
    const uniqueIds = [...new Set(orgIds)];
    if (uniqueIds.length === 0) {
      return new Map<UuidV7, UuidV7>();
    }

    const db = dbExecutor ?? getDb();
    const rows = await db
      .select({
        id: identityOrganizations.id,
        metadata: identityOrganizations.metadata,
      })
      .from(identityOrganizations)
      .where(inArray(identityOrganizations.id, uniqueIds));

    const ownerByOrg = new Map<UuidV7, UuidV7>();
    for (const row of rows) {
      const { ownerUserId } = parseMetadata(row.metadata);
      if (typeof ownerUserId === "string") {
        ownerByOrg.set(row.id as UuidV7, ownerUserId as UuidV7);
      }
    }
    return ownerByOrg;
  }

  async findByProjectId(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<OrganizationEntity | null> {
    const db = dbExecutor ?? getDb();
    const [projectRow] = await db
      .select({ orgId: projects.orgId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!projectRow?.orgId) {
      return null;
    }

    return await this.load(projectRow.orgId as UuidV7, db);
  }

  async createPersonalOrg(
    args: CreatePersonalOrgArgs,
    dbExecutor?: DbExecutor,
  ): Promise<OrganizationEntity> {
    const createInExecutor = async (
      tx: DbExecutor,
    ): Promise<OrganizationEntity> => {
      const slug = personalOrgSlug(args.ownerUserId);

      const [existing] = await tx
        .select()
        .from(identityOrganizations)
        .where(eq(identityOrganizations.slug, slug))
        .limit(1);

      if (existing) {
        const memberRows = await this.loadMembers(existing.id as UuidV7, tx);
        return this.toEntity(existing, memberRows);
      }

      const organization = OrganizationEntity.createPersonal({
        id: createUuidV7(),
        name: personalOrgName(args.ownerName),
        slug,
        ownerUserId: args.ownerUserId,
      });

      // `ON CONFLICT (slug) DO NOTHING` makes this safe against concurrent
      // callers racing on the same personal-org slug (e.g. two `createProject`
      // requests for the same actor in flight at once). The first insert wins;
      // the loser's insert is a no-op and it falls through to re-select the
      // winning row below, preserving idempotency without a unique-violation.
      const [insertedRow] = await tx
        .insert(identityOrganizations)
        .values({
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          metadata: JSON.stringify({
            personal: true,
            ownerUserId: organization.ownerUserId,
          }),
        })
        .onConflictDoNothing({ target: identityOrganizations.slug })
        .returning();

      const [orgRow] = insertedRow
        ? [insertedRow]
        : await tx
            .select()
            .from(identityOrganizations)
            .where(eq(identityOrganizations.slug, slug))
            .limit(1);

      if (!orgRow) {
        throw new PersistenceError(
          `Failed to create personal organization for user ${args.ownerUserId}`,
          "ORGANIZATION_CREATE_FAILED",
        );
      }

      const ownerMembership = organization.members.find((member) =>
        member.isOwner(),
      );
      if (!ownerMembership) {
        throw new PersistenceError(
          "Personal organization is missing its owner member",
          "ORGANIZATION_OWNER_MISSING",
        );
      }

      // Seed the owner membership only when THIS call actually inserted the org
      // (`insertedRow` truthy). If the org already existed — whether from a
      // prior call or a concurrent winner that lost the slug race above — that
      // path owns the membership, so re-inserting here would create a duplicate
      // (the `member` table has no (organization_id, user_id) unique key).
      if (insertedRow) {
        await tx.insert(identityOrganizationMembers).values({
          id: createUuidV7(),
          organizationId: orgRow.id,
          userId: ownerMembership.userId,
          role: ownerMembership.role,
        });
      }

      const memberRows = await this.loadMembers(orgRow.id as UuidV7, tx);
      return this.toEntity(orgRow, memberRows);
    };

    if (dbExecutor) {
      if ("transaction" in dbExecutor) {
        return await dbExecutor.transaction(
          async (tx) => await createInExecutor(tx),
        );
      }
      return await createInExecutor(dbExecutor);
    }

    return await getDb().transaction(
      async (tx) => await createInExecutor(tx),
    );
  }
}

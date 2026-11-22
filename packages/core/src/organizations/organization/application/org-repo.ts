import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { OrganizationEntity } from "../domain/organization-entity";

export type CreatePersonalOrgArgs = {
  ownerUserId: UuidV7;
  ownerName: string | null;
};

export type OrgRepo = {
  /** Load an organization (with its members) by id. */
  load(id: UuidV7, dbExecutor?: DbExecutor): Promise<OrganizationEntity | null>;
  /**
   * Resolve the personal organization owned by the user with the given
   * username. Returns null when no such username exists or the user has no
   * personal org yet. Used by pretty-URL routing (`/{username}/{slug}`).
   */
  loadPersonalOrgByOwnerUsername(
    username: string,
    dbExecutor?: DbExecutor,
  ): Promise<OrganizationEntity | null>;
  /** Resolve the organization that owns a given project. */
  findByProjectId(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<OrganizationEntity | null>;
  /**
   * Batch-resolve the owning user id for each of the given organizations.
   * Returns a map keyed by org id; orgs that are missing or have no owner
   * (e.g. a non-personal org without an `ownerUserId`) are omitted. Used at
   * read time to resolve a project's owner username without an N+1 lookup.
   */
  loadOwnerUserIdsByOrgId(
    orgIds: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<Map<UuidV7, UuidV7>>;
  /**
   * Idempotently create (or return the existing) personal organization owned
   * by the given user.
   */
  createPersonalOrg(
    args: CreatePersonalOrgArgs,
    dbExecutor?: DbExecutor,
  ): Promise<OrganizationEntity>;
};

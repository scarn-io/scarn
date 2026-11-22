import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { ProjectEntity } from "../domain/project-entity";

export type ProjectRepo = {
  load(id: UuidV7, dbExecutor?: DbExecutor): Promise<ProjectEntity | null>;
  /** Locks the project row before reading memberships; requires a transaction. */
  loadForUpdate(
    id: UuidV7,
    dbExecutor: DbExecutor,
  ): Promise<ProjectEntity | null>;
  loadMany(ids: UuidV7[], dbExecutor?: DbExecutor): Promise<ProjectEntity[]>;
  listByUser(userId: UuidV7, dbExecutor?: DbExecutor): Promise<ProjectEntity[]>;
  /** Resolve a project within an org by its URL slug (for pretty-URL routing). */
  loadByOrgAndSlug(
    orgId: UuidV7,
    slug: string,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectEntity | null>;
  /** Slugs already taken within an org, used to de-dup a new project's slug. */
  listSlugsByOrg(orgId: UuidV7, dbExecutor?: DbExecutor): Promise<string[]>;
  create(
    project: ProjectEntity,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectEntity>;
  save(project: ProjectEntity, dbExecutor?: DbExecutor): Promise<ProjectEntity>;
};

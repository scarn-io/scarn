import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type {
  GitHubAppProjectIntegration,
  ProjectIntegrationEntity,
} from "../domain/project-integration-entity";

export type ProjectIntegrationRepo = {
  create(
    integration: ProjectIntegrationEntity,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectIntegrationEntity>;
  save(
    integration: ProjectIntegrationEntity,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectIntegrationEntity>;
  findById(
    id: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectIntegrationEntity | null>;
  listByProjectId(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectIntegrationEntity[]>;
  findByInstallationId(
    installationId: string,
    dbExecutor?: DbExecutor,
  ): Promise<GitHubAppProjectIntegration[]>;
  listActive(
    dbExecutor?: DbExecutor,
    options?: { pageSize?: number },
  ): Promise<ProjectIntegrationEntity[]>;
  /**
   * Integrations the auto-sync poller should consider: a lent key is set
   * (`sync_secret_id IS NOT NULL`) and status is `active` or `error`.
   * Keyset-paged internally like `listActive`.
   */
  listDueForAutoSync(
    dbExecutor?: DbExecutor,
    options?: { pageSize?: number },
  ): Promise<ProjectIntegrationEntity[]>;
  listBySyncSecretId(
    secretId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectIntegrationEntity[]>;
  listBySyncSecretIds(
    secretIds: UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<ProjectIntegrationEntity[]>;
  /**
   * Atomically takes the sync lock until `until`. Succeeds only when the
   * lock is unset or already expired relative to the database's `now()`.
   * Returns whether the claim was taken.
   */
  claimForSync(
    id: UuidV7,
    until: Date,
    dbExecutor?: DbExecutor,
  ): Promise<boolean>;
  releaseSyncClaim(id: UuidV7, dbExecutor?: DbExecutor): Promise<void>;
  delete(
    id: UuidV7,
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<number>;
  deleteByInstallationId(
    installationId: string,
    dbExecutor?: DbExecutor,
  ): Promise<number>;
};

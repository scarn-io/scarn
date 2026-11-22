import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { GitHubInstallationEntity } from "../domain/github-installation-entity";

export type GitHubInstallationRepo = {
  upsert(
    installation: GitHubInstallationEntity,
    dbExecutor?: DbExecutor,
  ): Promise<GitHubInstallationEntity>;
  findByInstallationId(
    installationId: string,
    dbExecutor?: DbExecutor,
  ): Promise<GitHubInstallationEntity | null>;
  /**
   * Returns every installation owned by this user. A user may install the
   * GitHub App on multiple orgs/accounts — this does not dedupe or merge
   * across installations.
   */
  findByInstalledByUserId(
    userId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<GitHubInstallationEntity[]>;
  deleteByInstallationId(
    installationId: string,
    dbExecutor?: DbExecutor,
  ): Promise<number>;
};

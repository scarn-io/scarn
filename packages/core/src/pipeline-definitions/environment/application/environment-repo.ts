import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { EnvironmentEntity } from "../domain/environment-entity";
import type { EnvironmentVersionEntity } from "../domain/environment-version-entity";

export type EnvironmentWithLatestVersion = {
  environment: EnvironmentEntity;
  latestVersion: EnvironmentVersionEntity;
};

export type EnvironmentWithVersion = {
  environment: EnvironmentEntity;
  version: EnvironmentVersionEntity;
};

export type EnvironmentRepo = {
  /** The environment named `name`, deleted or not. */
  findByName(
    projectId: UuidV7,
    name: string,
    dbExecutor?: DbExecutor,
  ): Promise<EnvironmentEntity | null>;
  /**
   * Locks the environment named `name` for the caller's transaction,
   * inserting `candidate` first when the project has none by that name.
   */
  lockOrCreate(
    candidate: EnvironmentEntity,
    dbExecutor: DbExecutor,
  ): Promise<EnvironmentEntity>;
  save(
    environment: EnvironmentEntity,
    dbExecutor?: DbExecutor,
  ): Promise<EnvironmentEntity>;
  /** Every environment that isn't deleted, by name, with its latest version. */
  listLiveWithLatestVersion(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<EnvironmentWithLatestVersion[]>;
  /**
   * The live (not deleted) environment named `name` with its latest version,
   * holding a share lock on the environment row for the caller's transaction.
   */
  findLiveWithLatestVersionByName(
    projectId: UuidV7,
    name: string,
    dbExecutor?: DbExecutor,
  ): Promise<EnvironmentWithLatestVersion | null>;
  /** The version with id `versionId`, with its environment, deleted or not. */
  findVersionById(
    versionId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<EnvironmentWithVersion | null>;
  loadVersion(
    environmentId: UuidV7,
    version: number,
    dbExecutor?: DbExecutor,
  ): Promise<EnvironmentVersionEntity | null>;
  insertVersion(
    version: EnvironmentVersionEntity,
    dbExecutor?: DbExecutor,
  ): Promise<EnvironmentVersionEntity>;
  /** Keys of the project's non-archived step definitions whose environment is `{ kind: "named", name }`. */
  listActiveStepKeysUsing(
    projectId: UuidV7,
    name: string,
    dbExecutor?: DbExecutor,
  ): Promise<string[]>;
};

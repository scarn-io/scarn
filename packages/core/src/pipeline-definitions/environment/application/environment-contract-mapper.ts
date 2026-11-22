import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type {
  UserDisplay,
  UsernameReader,
} from "@scarn/core/organizations/organization/application/username-reader";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type {
  EnvironmentContract,
  EnvironmentVersionContract,
} from "../contracts/environment-contracts";
import type { EnvironmentEntity } from "../domain/environment-entity";
import type { EnvironmentVersionEntity } from "../domain/environment-version-entity";

export type EnvironmentContractMapperDeps = {
  usernameReader: UsernameReader;
};

type EnvironmentAndVersion = {
  environment: EnvironmentEntity;
  version: EnvironmentVersionEntity;
};

const userRef = (userId: UuidV7, usernames: Map<UuidV7, UserDisplay>) => ({
  userId,
  username: usernames.get(userId)?.username ?? null,
});

const versionToContract = (
  version: EnvironmentVersionEntity,
  usernames: Map<UuidV7, UserDisplay>,
): EnvironmentVersionContract => ({
  id: version.id,
  environmentId: version.environmentId,
  version: version.version,
  content: version.content,
  contentHash: version.contentHash,
  createdBy: userRef(version.createdByUserId, usernames),
  createdAt: version.createdAt.toISOString(),
});

/** `latest` describes the environment as listed: its description and who last published it. */
const environmentToContract = (
  environment: EnvironmentEntity,
  latest: EnvironmentVersionEntity,
  usernames: Map<UuidV7, UserDisplay>,
): EnvironmentContract => ({
  id: environment.id,
  projectId: environment.projectId,
  name: environment.name,
  description: latest.content.description ?? null,
  latestVersion: environment.latestVersion,
  updatedBy: userRef(latest.createdByUserId, usernames),
  updatedAt: latest.createdAt.toISOString(),
});

const loadUsernames = async (
  versions: readonly EnvironmentVersionEntity[],
  deps: EnvironmentContractMapperDeps,
  dbExecutor?: DbExecutor,
): Promise<Map<UuidV7, UserDisplay>> =>
  versions.length === 0
    ? new Map()
    : await deps.usernameReader.loadUsernamesByUserId(
        versions.map((version) => version.createdByUserId),
        dbExecutor,
      );

/** Maps environments with their latest versions, resolving usernames in one batch. */
export const environmentsToContracts = async (
  rows: readonly {
    environment: EnvironmentEntity;
    latestVersion: EnvironmentVersionEntity;
  }[],
  deps: EnvironmentContractMapperDeps,
  dbExecutor?: DbExecutor,
): Promise<EnvironmentContract[]> => {
  const usernames = await loadUsernames(
    rows.map((row) => row.latestVersion),
    deps,
    dbExecutor,
  );
  return rows.map((row) =>
    environmentToContract(row.environment, row.latestVersion, usernames),
  );
};

/** Maps an environment and one of its versions; `latest` is its latest version. */
export const environmentWithVersionToContract = async (
  { environment, version }: EnvironmentAndVersion,
  latest: EnvironmentVersionEntity,
  deps: EnvironmentContractMapperDeps,
  dbExecutor?: DbExecutor,
): Promise<{
  environment: EnvironmentContract;
  version: EnvironmentVersionContract;
}> => {
  const usernames = await loadUsernames([version, latest], deps, dbExecutor);
  return {
    environment: environmentToContract(environment, latest, usernames),
    version: versionToContract(version, usernames),
  };
};

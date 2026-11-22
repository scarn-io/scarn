import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type {
  UserDisplay,
  UsernameReader,
} from "@scarn/core/organizations/organization/application/username-reader";
import { InvariantViolationError } from "@scarn/core/lib/errors";
import type { ProjectSecretContract } from "../contracts/project-secret-contracts";
import type {
  ProjectSecretEntity,
  SecretEntity,
} from "../domain/secret-entity";

export type ProjectSecretContractMapperDeps = {
  usernameReader: UsernameReader;
};

/** Narrows a project-owned secret; any other kind is a data bug. */
export const asProjectSecret = (secret: SecretEntity): ProjectSecretEntity => {
  if (secret.kind !== "project_secret") {
    throw new InvariantViolationError(
      `Secret ${secret.id} is owned by a project but has kind '${secret.kind}'`,
    );
  }
  return secret;
};

const toContract = (
  secret: ProjectSecretEntity,
  usernames: Map<UuidV7, UserDisplay>,
): ProjectSecretContract => ({
  id: secret.id,
  projectId: secret.owner.projectId,
  name: secret.name,
  lastFour: secret.lastFour,
  updatedBy:
    secret.updatedByUserId === null
      ? null
      : {
          userId: secret.updatedByUserId,
          username: usernames.get(secret.updatedByUserId)?.username ?? null,
        },
  lastUsedAt: secret.lastUsedAt?.toISOString() ?? null,
  createdAt: secret.createdAt.toISOString(),
  updatedAt: secret.updatedAt.toISOString(),
});

/** Maps project secrets to their value-free contract, resolving `updatedBy` usernames in one batch. */
export const projectSecretsToContracts = async (
  secrets: readonly SecretEntity[],
  deps: ProjectSecretContractMapperDeps,
): Promise<ProjectSecretContract[]> => {
  const projectSecrets = secrets.map(asProjectSecret);
  const userIds = projectSecrets.flatMap((secret) =>
    secret.updatedByUserId === null ? [] : [secret.updatedByUserId],
  );
  const usernames =
    userIds.length === 0
      ? new Map<UuidV7, UserDisplay>()
      : await deps.usernameReader.loadUsernamesByUserId(userIds);
  return projectSecrets.map((secret) => toContract(secret, usernames));
};

export const projectSecretToContract = async (
  secret: SecretEntity,
  deps: ProjectSecretContractMapperDeps,
): Promise<ProjectSecretContract> => {
  const [contract] = await projectSecretsToContracts([secret], deps);
  if (!contract) {
    throw new InvariantViolationError("Expected one mapped project secret");
  }
  return contract;
};

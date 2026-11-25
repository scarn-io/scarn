import type { SecretContract } from "../contracts/secret-contracts";
import { InvariantViolationError } from "@scarn/core/lib/errors";
import type { SecretEntity } from "../domain/secret-entity";

/** Never includes the value, encrypted or not, nor the owner. */
export const secretEntityToContract = (
  entity: SecretEntity,
  now: Date,
): SecretContract => {
  const shared = {
    id: entity.id,
    name: entity.name,
    lastFour: entity.lastFour,
    lastUsedAt: entity.lastUsedAt?.toISOString() ?? null,
    status: entity.status(now),
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
  };
  switch (entity.kind) {
    case "jira_api_key":
      return {
        ...shared,
        kind: entity.kind,
        metadata: { email: entity.metadata.email },
        expiresAt: entity.expiresAt.toISOString(),
      };
    case "github_token":
      return {
        ...shared,
        kind: entity.kind,
        metadata: { login: entity.metadata.login },
        expiresAt: entity.expiresAt?.toISOString() ?? null,
      };
    case "bitbucket_api_token":
      return {
        ...shared,
        kind: entity.kind,
        metadata: { email: entity.metadata.email },
        expiresAt: entity.expiresAt.toISOString(),
      };
    case "project_secret":
      throw new InvariantViolationError(
        `Secret ${entity.id} is a project secret, not a user's saved key`,
      );
  }
};

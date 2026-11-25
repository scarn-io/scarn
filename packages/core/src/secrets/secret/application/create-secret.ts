import {
  createUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import {
  createSecretSchema,
  type CreateSecretInput,
  type SecretContract,
} from "../contracts/secret-contracts";
import {
  SecretEntity,
  type CreateSecretEntityProps,
} from "../domain/secret-entity";
import { secretAad } from "../domain/secret-aad";
import { userSecretOwner, type UserSecretOwner } from "../domain/secret-owner";
import type { SecretCipher } from "./secret-cipher";
import type { SecretRepo } from "./secret-repo";
import { secretEntityToContract } from "./secret-contract-mapper";

type CreateSecretDeps = {
  userAuthz: UserAuthorizationService;
  secretRepo: SecretRepo;
  secretCipher: SecretCipher;
  timeProvider: TimeProvider;
};

const toEntityProps = (
  parsed: CreateSecretInput,
  shared: {
    id: UuidV7;
    owner: UserSecretOwner;
    name: string;
    encryptedValue: CreateSecretEntityProps["encryptedValue"];
    lastFour: string;
    now: Date;
  },
): CreateSecretEntityProps => {
  switch (parsed.kind) {
    case "jira_api_key":
      return {
        ...shared,
        kind: parsed.kind,
        metadata: { email: parsed.email },
        expiresAt: new Date(parsed.expiresAt),
      };
    case "github_token":
      return {
        ...shared,
        kind: parsed.kind,
        metadata: { login: parsed.login ?? null },
        expiresAt: parsed.expiresAt ? new Date(parsed.expiresAt) : null,
      };
    case "bitbucket_api_token":
      return {
        ...shared,
        kind: parsed.kind,
        metadata: { email: parsed.email },
        expiresAt: new Date(parsed.expiresAt),
      };
  }
};

/** Encrypts and saves a new secret owned by the caller. */
export const createSecret = async (
  input: CreateSecretInput,
  deps: CreateSecretDeps,
): Promise<SecretContract> => {
  const parsed = createSecretSchema.parse(input);
  const now = deps.timeProvider.now();
  const id = createUuidV7();
  const owner = userSecretOwner(deps.userAuthz.actorId);

  const entity = SecretEntity.create(
    toEntityProps(parsed, {
      id,
      owner,
      name: parsed.name,
      encryptedValue: deps.secretCipher.encrypt(
        parsed.value,
        secretAad({ id, owner }),
      ),
      lastFour: parsed.value.slice(-4),
      now,
    }),
  );

  return secretEntityToContract(await deps.secretRepo.save(entity), now);
};

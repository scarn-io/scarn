import { expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { CoreError } from "@/lib/errors";
import type { ResolveCredentialDeps } from "@/secrets/secret/application/decrypt-saved-credential";
import type { SecretRepo } from "@/secrets/secret/application/secret-repo";
import {
  SecretEntity,
  type CreateSecretEntityProps,
} from "@/secrets/secret/domain/secret-entity";
import { secretAad } from "@/secrets/secret/domain/secret-aad";
import {
  ownerKey,
  userSecretOwner,
  type SecretOwner,
} from "@/secrets/secret/domain/secret-owner";
import { AesGcmSecretCipher } from "@/secrets/secret/infra/aes-gcm-secret-cipher";
import { fixedTimeProvider } from "tests/utils";

const DAY_MS = 24 * 60 * 60 * 1000;

export const RESOLVER_TEST_NOW = new Date("2026-10-20T12:00:00.000Z");

export const daysFrom = (days: number): Date =>
  new Date(RESOLVER_TEST_NOW.getTime() + days * DAY_MS);

const sameOwner = (a: SecretOwner, b: SecretOwner) =>
  ownerKey(a) === ownerKey(b);

class InMemorySecretRepo implements SecretRepo {
  private readonly rows = new Map<UuidV7, SecretEntity>();

  save(entity: SecretEntity): Promise<SecretEntity> {
    this.rows.set(entity.id, entity);
    return Promise.resolve(entity);
  }

  findById(id: UuidV7) {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  findByIdForOwner(id: UuidV7, owner: SecretOwner) {
    const secret = this.rows.get(id);
    return Promise.resolve(
      secret && sameOwner(secret.owner, owner) ? secret : null,
    );
  }

  listSummariesByIds(ids: readonly UuidV7[]) {
    return Promise.resolve(
      ids.flatMap((id) => {
        const secret = this.rows.get(id);
        return secret?.owner.type === "user"
          ? [{ id, name: secret.name, ownerUserId: secret.owner.userId }]
          : [];
      }),
    );
  }

  listByOwner(owner: SecretOwner) {
    return Promise.resolve(
      [...this.rows.values()].filter((s) => sameOwner(s.owner, owner)),
    );
  }

  delete(id: UuidV7, owner: SecretOwner) {
    const secret = this.rows.get(id);
    if (!secret || !sameOwner(secret.owner, owner)) {
      return Promise.resolve(false);
    }
    this.rows.delete(id);
    return Promise.resolve(true);
  }
}

type SaveableProps = CreateSecretEntityProps extends infer P
  ? P extends CreateSecretEntityProps
    ? Omit<P, "owner" | "encryptedValue" | "lastFour" | "now" | "id">
    : never
  : never;

/** A resolver harness: an in-memory repo, a real cipher, and a fixed clock. */
export const createResolverHarness = (now: Date = RESOLVER_TEST_NOW) => {
  const actorId = createUuidV7();
  const owner = userSecretOwner(actorId);
  const secretRepo = new InMemorySecretRepo();
  const secretCipher = new AesGcmSecretCipher({
    keys: new Map([[1, randomBytes(32)]]),
    currentKeyVersion: 1,
  });
  const deps: ResolveCredentialDeps = {
    secretRepo,
    secretCipher,
    userAuthz: {
      actorId,
      requireProjectMember: () =>
        Promise.reject(new Error("requireProjectMember is not used here")),
      requireProjectPermission: () => {
        throw new Error("not used");
      },
    },
    timeProvider: fixedTimeProvider(now),
  };

  const saveSecret = async (
    props: SaveableProps,
    value: string,
    secretOwner: SecretOwner = owner,
  ): Promise<SecretEntity> => {
    const id = createUuidV7();
    const createProps = {
      ...props,
      id,
      owner: secretOwner,
      encryptedValue: secretCipher.encrypt(
        value,
        secretAad({ id, owner: secretOwner }),
      ),
      lastFour: value.slice(-4),
      now: RESOLVER_TEST_NOW,
    } as CreateSecretEntityProps;
    return await secretRepo.save(SecretEntity.create(createProps));
  };

  return { deps, owner, saveSecret };
};

export const expectCoreErrorAsync = async (
  promise: Promise<unknown>,
  code: string,
): Promise<CoreError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).code).toBe(code);
    return error as CoreError;
  }
  throw new Error(`Expected ${code} to be thrown`);
};

import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { SecretEntity, SecretKind } from "../domain/secret-entity";
import type { SecretOwner } from "../domain/secret-owner";

export type ListSecretsByOwnerOptions = {
  kind?: SecretKind | undefined;
};

/** Value-free identity of a secret: never carries ciphertext or last four. */
export type SecretSummary = {
  id: UuidV7;
  name: string;
  ownerUserId: UuidV7;
};

/**
 * Every read and delete is scoped to an owner in the query itself, so a
 * secret ID belonging to someone else behaves exactly like a missing one.
 * The exceptions are `listSummariesByIds`, which returns no secret material
 * at all, and `findById`, which only the auto-sync poller may call.
 */
export interface SecretRepo {
  /**
   * Unscoped lookup by ID, ciphertext included. Only
   * `resolveIntegrationSyncCredential` (which checks the owner still belongs
   * to the project before decrypting) and `markLentSecretUsed` may call
   * this. Every request handler must use `findByIdForOwner`.
   */
  findById(id: UuidV7, dbExecutor?: DbExecutor): Promise<SecretEntity | null>;
  /**
   * Unscoped, value-free lookup used to show who a project integration
   * auto-syncs as (key name + owner) to other project members. Never selects
   * ciphertext, IV, auth tag or last four. Missing IDs are omitted.
   */
  listSummariesByIds(
    ids: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<SecretSummary[]>;
  /**
   * Inserts or updates the secret. Throws `SECRET_NAME_TAKEN` (409) when the
   * owner already has a secret with the same name (per kind for users, across
   * the whole project for projects).
   */
  save(entity: SecretEntity, dbExecutor?: DbExecutor): Promise<SecretEntity>;
  findByIdForOwner(
    id: UuidV7,
    owner: SecretOwner,
    dbExecutor?: DbExecutor,
  ): Promise<SecretEntity | null>;
  /**
   * Newest first. A row whose stored metadata doesn't read is logged and
   * left out; the single-row reads throw `SECRET_ROW_UNREADABLE` instead.
   */
  listByOwner(
    owner: SecretOwner,
    options?: ListSecretsByOwnerOptions,
    dbExecutor?: DbExecutor,
  ): Promise<SecretEntity[]>;
  /** Returns whether a row was deleted. */
  delete(
    id: UuidV7,
    owner: SecretOwner,
    dbExecutor?: DbExecutor,
  ): Promise<boolean>;
}

import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { ManagedOAuthGrantEntity } from "../domain/managed-oauth-grant-entity";

/**
 * Grant rows hold ciphertext only and nothing here decrypts. Only the use
 * cases built to use a grant's plaintext (in this slice, revocation) call
 * `ManagedGrantCrypto` on what this returns. Every read is scoped to the
 * project and connection.
 */
export interface ManagedOAuthGrantRepo {
  insert(
    grant: ManagedOAuthGrantEntity,
    dbExecutor?: DbExecutor,
  ): Promise<void>;
  findById(
    projectId: UuidV7,
    connectionId: UuidV7,
    grantId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ManagedOAuthGrantEntity | null>;
  /** Writes the grant's mutable state unconditionally (e.g. a retirement or a new refresh claim). */
  save(grant: ManagedOAuthGrantEntity, dbExecutor?: DbExecutor): Promise<void>;
  /**
   * Compare-and-set write of a refresh result: writes only if the stored grant
   * is live, still holds `expectedClaimId` and is at
   * `expectedCredentialVersion`. Returns false, writing nothing, otherwise.
   */
  saveIfClaim(
    grant: ManagedOAuthGrantEntity,
    expectedClaimId: UuidV7,
    expectedCredentialVersion: number,
    dbExecutor?: DbExecutor,
  ): Promise<boolean>;
  delete(
    projectId: UuidV7,
    connectionId: UuidV7,
    grantId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<boolean>;
  /**
   * Maintenance, across projects: deletes up to `limit` grants retired before
   * `retiredBefore` that no connection points at. Returns how many it deleted.
   */
  deleteRetiredBefore(
    input: { retiredBefore: Date; limit: number },
    dbExecutor?: DbExecutor,
  ): Promise<number>;
}

import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type {
  ManagedOAuthAttemptEntity,
  ManagedOAuthAttemptStatus,
} from "../domain/managed-oauth-attempt-entity";

export interface ManagedOAuthAttemptRepo {
  insert(
    attempt: ManagedOAuthAttemptEntity,
    dbExecutor?: DbExecutor,
  ): Promise<void>;
  findByStateDigest(
    stateDigest: string,
    dbExecutor?: DbExecutor,
  ): Promise<ManagedOAuthAttemptEntity | null>;
  /** The attempt whose callback stored `candidateGrantId`, if it is still recorded. */
  findByCandidateGrant(
    projectId: UuidV7,
    candidateGrantId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ManagedOAuthAttemptEntity | null>;
  /**
   * Writes `attempt` only if the stored row is still in `expectedStatus`, so
   * two callbacks racing for one attempt can't both claim it.
   */
  saveIfStatus(
    attempt: ManagedOAuthAttemptEntity,
    expectedStatus: ManagedOAuthAttemptStatus,
    dbExecutor?: DbExecutor,
  ): Promise<boolean>;
  /** Attempts still `pending` or `exchanging` for the connection. */
  listOpenByConnection(
    projectId: UuidV7,
    connectionId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ManagedOAuthAttemptEntity[]>;
  /**
   * Maintenance, across projects: `pending` attempts past `expiresAt` by
   * `now`, and `exchanging` attempts whose exchange began before
   * `exchangingBefore`. Oldest first, at most `limit`.
   */
  listLapsedOpen(
    input: { now: Date; exchangingBefore: Date; limit: number },
    dbExecutor?: DbExecutor,
  ): Promise<ManagedOAuthAttemptEntity[]>;
}

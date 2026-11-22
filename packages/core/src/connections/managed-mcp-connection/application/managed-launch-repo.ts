import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type {
  ManagedLaunchConnectionEntity,
  ManagedOperation,
} from "../domain/managed-launch-connection-entity";

/** A leased operation and the connection it relays to, for the authority fence. */
export type ManagedRunOperation = ManagedOperation & {
  connectionId: UuidV7;
};

/**
 * Launch connections and their leased operations. Rows are found by run or
 * by capability digest; a capability belongs to exactly one launch
 * connection, so it already names the run, project and connection.
 */
export interface ManagedLaunchRepo {
  /**
   * Inserts `entity`, or, when the run already has a row for the same claim
   * and entry key, replaces its pinned connection, generation, grant and
   * capability digest, clears its session binding and reopens it. Returns
   * the stored row, whose ID is the existing one on replacement.
   */
  upsertOpen(
    entity: ManagedLaunchConnectionEntity,
    dbExecutor: DbExecutor,
  ): Promise<ManagedLaunchConnectionEntity>;
  /** Open or closed: the caller decides what a closed row means. */
  loadByCapabilityDigest(
    capabilityDigest: Buffer,
    dbExecutor?: DbExecutor,
  ): Promise<ManagedLaunchConnectionEntity | null>;
  /** Ordered by entry key. */
  listOpenForRun(
    taskRunId: UuidV7,
    dbExecutor: DbExecutor,
  ): Promise<ManagedLaunchConnectionEntity[]>;
  /** Distinct runs pinned to this connection by open launch rows, regardless of run status. */
  countOpenRunsForConnection(
    projectId: UuidV7,
    connectionId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<number>;
  /** Writes the session binding of an open row. Returns false if it is closed. */
  saveSessionBinding(
    entity: ManagedLaunchConnectionEntity,
    dbExecutor?: DbExecutor,
  ): Promise<boolean>;
  /** Closes every open row of the run. Returns how many it closed. */
  closeAllForRun(
    taskRunId: UuidV7,
    now: Date,
    dbExecutor: DbExecutor,
  ): Promise<number>;
  /** Closes a bounded batch whose runs are terminal, including expired running clocks. */
  closeTerminalLaunches(input: { now: Date; limit: number }): Promise<number>;
  /** Deletes closed launches only after a recorded terminal outcome predates the cutoff; operations cascade. */
  deleteEndedRunLaunchesBefore(input: {
    endedBefore: Date;
    limit: number;
  }): Promise<number>;
  /**
   * Leases `operation` on its launch connection, locking that row so
   * concurrent admissions count one at a time. Returns false, and writes
   * nothing, when the row is closed or already holds
   * `MANAGED_LAUNCH_MAX_OPEN_OPERATIONS` operations.
   */
  insertOperation(
    operation: ManagedOperation,
    dbExecutor: DbExecutor,
  ): Promise<boolean>;
  deleteOperation(operationId: UuidV7, dbExecutor?: DbExecutor): Promise<void>;
  /** Every operation leased by any of the run's launch connections, oldest first. */
  listOperations(
    taskRunId: UuidV7,
    dbExecutor: DbExecutor,
  ): Promise<ManagedRunOperation[]>;
  /**
   * For the authority fence: locks the run's open launch connections
   * (`FOR UPDATE`, the lock `insertOperation` takes) for the rest of the
   * transaction, then lists their operations, oldest first. An admission
   * that leased an operation first is seen; one that waits on the lock finds
   * the launch closed once the seal commits.
   */
  lockOperationsForSeal(
    taskRunId: UuidV7,
    dbExecutor: DbExecutor,
  ): Promise<ManagedRunOperation[]>;
}

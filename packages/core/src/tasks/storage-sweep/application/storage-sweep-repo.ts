import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { StorageSweep, SweptRun } from "../domain/storage-sweep";

export interface StorageSweepRepo {
  /** Inserts one sweep per run, due at `notBefore`. */
  schedule(
    runs: SweptRun[],
    input: { notBefore: Date; createdAt: Date },
    dbExecutor: DbExecutor,
  ): Promise<void>;
  /**
   * Atomically claims up to `limit` sweeps due at `now`, skipping rows another
   * sweeper holds, and hides them until `leaseUntil` so concurrent sweepers
   * never process the same row.
   */
  claimDue(
    input: { now: Date; leaseUntil: Date; limit: number },
    dbExecutor?: DbExecutor,
  ): Promise<StorageSweep[]>;
  /** Removes a sweep that finished. */
  complete(id: StorageSweep["id"], dbExecutor?: DbExecutor): Promise<void>;
  /** Records a failed attempt and when to retry. */
  recordFailure(
    id: StorageSweep["id"],
    input: { attempts: number; lastError: string; notBefore: Date },
    dbExecutor?: DbExecutor,
  ): Promise<void>;
  /** Counts sweeps created before `createdBefore` or failed `minAttempts`+ times. */
  countOverdue(
    input: { createdBefore: Date; minAttempts: number },
    dbExecutor?: DbExecutor,
  ): Promise<number>;
}

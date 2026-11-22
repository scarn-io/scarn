import type { Logger } from "@scarn/observability/logging";
import type { ObjectStore } from "@scarn/core/artifacts/object-store";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import {
  STORAGE_SWEEP_CLAIM_LEASE_MS,
  STORAGE_SWEEP_MAX_ERROR_LENGTH,
  STORAGE_SWEEP_OVERDUE_AGE_MS,
  STORAGE_SWEEP_OVERDUE_ATTEMPTS,
  nextStorageSweepAttemptAt,
  type StorageSweep,
} from "../domain/storage-sweep";
import { deleteRunPrefixes } from "./delete-run-storage";
import type { StorageSweepRepo } from "./storage-sweep-repo";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_BATCHES = 50;

export type SweepDeletedStorageDeps = {
  storageSweepRepo: StorageSweepRepo;
  /** Null when object storage isn't configured; every due sweep then fails. */
  objectStore: ObjectStore | null;
  timeProvider: TimeProvider;
  logger?: Logger | undefined;
  /** Sweeps claimed per batch. Defaults to 100. */
  batchSize?: number | undefined;
  /** Max batches per invocation. Defaults to 50. */
  maxBatches?: number | undefined;
  dbExecutor?: DbExecutor | undefined;
};

export type SweepDeletedStorageResult = {
  swept: number;
  failed: number;
  /** Sweeps older than a day or failed repeatedly, still pending after this run. */
  overdue: number;
};

// eslint-disable-next-line local/no-unknown-parameter-type
const describeError = (error: unknown): string => {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.slice(0, STORAGE_SWEEP_MAX_ERROR_LENGTH);
};

/**
 * SCHEDULED maintenance use case (no auth actor): the second pass of the
 * deletion contract. Claims due sweeps in bounded batches (`FOR UPDATE SKIP
 * LOCKED`, so concurrent sweepers never share a row), deletes each run's
 * prefixes, and removes the sweep on success. A failure (including object
 * storage not being configured) keeps the row, records the error and retries
 * it later with a growing backoff. Idempotent: a duplicate or missed run is
 * harmless, and the 30-day lifecycle rules are the backstop.
 */
export const sweepDeletedStorage = async (
  deps: SweepDeletedStorageDeps,
): Promise<SweepDeletedStorageResult> => {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = deps.maxBatches ?? DEFAULT_MAX_BATCHES;
  const { storageSweepRepo, objectStore, timeProvider, logger, dbExecutor } =
    deps;

  const sweep = async (row: StorageSweep): Promise<boolean> => {
    try {
      if (!objectStore) {
        throw new Error("Object storage is not configured");
      }
      await deleteRunPrefixes(row, objectStore);
      await storageSweepRepo.complete(row.id, dbExecutor);
      return true;
    } catch (error) {
      const attempts = row.attempts + 1;
      await storageSweepRepo.recordFailure(
        row.id,
        {
          attempts,
          lastError: describeError(error),
          notBefore: nextStorageSweepAttemptAt(timeProvider.now(), attempts),
        },
        dbExecutor,
      );
      logger?.warn(
        {
          storageSweepId: row.id,
          projectId: row.projectId,
          taskRunId: row.taskRunId,
          attempts,
          error,
        },
        "Storage sweep failed; will retry",
      );
      return false;
    }
  };

  let swept = 0;
  let failed = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const now = timeProvider.now();
    const claimed = await storageSweepRepo.claimDue(
      {
        now,
        leaseUntil: new Date(now.getTime() + STORAGE_SWEEP_CLAIM_LEASE_MS),
        limit: batchSize,
      },
      dbExecutor,
    );
    if (claimed.length === 0) {
      break;
    }
    const outcomes = await Promise.all(claimed.map(sweep));
    swept += outcomes.filter(Boolean).length;
    failed += outcomes.filter((ok) => !ok).length;
  }

  const now = timeProvider.now();
  const overdue = await storageSweepRepo.countOverdue(
    {
      createdBefore: new Date(now.getTime() - STORAGE_SWEEP_OVERDUE_AGE_MS),
      minAttempts: STORAGE_SWEEP_OVERDUE_ATTEMPTS,
    },
    dbExecutor,
  );

  if (overdue > 0) {
    logger?.error(
      {
        overdue,
        overdueAgeHours: STORAGE_SWEEP_OVERDUE_AGE_MS / 3_600_000,
        overdueAttempts: STORAGE_SWEEP_OVERDUE_ATTEMPTS,
      },
      "Storage sweeps are overdue: older than a day or failing repeatedly",
    );
  }
  if (swept > 0 || failed > 0) {
    logger?.info({ swept, failed, overdue }, "Swept deleted runs' storage");
  }

  return { swept, failed, overdue };
};

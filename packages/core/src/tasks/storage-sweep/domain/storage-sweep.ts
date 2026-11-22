import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { artifactRunPrefix } from "@scarn/core/tasks/task-artifact/domain/artifact-object-key";
import { taskLogArchivePrefix } from "@scarn/core/tasks/task-log/domain/task-log-archive-prefix";
import { taskRunSessionPrefix } from "@scarn/core/tasks/task-run/domain/task-run-session-object-key";

/**
 * A storage sweep removes every object a deleted run left in object storage.
 * Rows are scheduled in the transaction that deletes the runs, so they outlive
 * the runs (and their project): `storage_sweeps` has no foreign keys.
 *
 * See docs/adr/0003-conversation-deletion-contract.md.
 */

/** A deleted run whose stored objects must be swept. */
export type SweptRun = {
  projectId: UuidV7;
  taskRunId: UuidV7;
};

export type StorageSweep = SweptRun & {
  id: UuidV7;
  notBefore: Date;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
};

/**
 * How long after the delete the scheduled sweep runs. Longer than the 900s
 * session upload URLs, so uploads issued (or in flight) at delete time have
 * landed before the second pass.
 */
export const STORAGE_SWEEP_DELAY_MS = 60 * 60 * 1_000;

/**
 * How long a claimed sweep is hidden from other sweepers. A sweeper that dies
 * mid-sweep leaves the row due again once this lapses.
 */
export const STORAGE_SWEEP_CLAIM_LEASE_MS = 15 * 60 * 1_000;

const RETRY_BACKOFF_STEP_MS = 60 * 60 * 1_000;
const MAX_RETRY_BACKOFF_STEPS = 24;

/** A sweep this old, or failed this many times, is reported as overdue. */
export const STORAGE_SWEEP_OVERDUE_AGE_MS = 24 * 60 * 60 * 1_000;
export const STORAGE_SWEEP_OVERDUE_ATTEMPTS = 3;

/** Longest stored `last_error`; S3 error messages are short, this is a guard. */
export const STORAGE_SWEEP_MAX_ERROR_LENGTH = 1_000;

/** The three prefixes holding a run's objects, built from the key helpers. */
export const storageSweepPrefixes = (run: SweptRun): string[] => [
  taskRunSessionPrefix(run.taskRunId),
  taskLogArchivePrefix(run.taskRunId),
  artifactRunPrefix(run),
];

/**
 * When a sweep that has now failed `attempts` times is retried: one hour per
 * failure, capped at a day.
 */
export const nextStorageSweepAttemptAt = (now: Date, attempts: number): Date =>
  new Date(
    now.getTime() +
      Math.min(Math.max(attempts, 1), MAX_RETRY_BACKOFF_STEPS) *
        RETRY_BACKOFF_STEP_MS,
  );

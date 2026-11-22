import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor, DbTransaction } from "@scarn/core/lib/db/db-executor";
import type { Logger } from "@scarn/observability/logging";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { LogFeedStore } from "./log-feed-store";

/**
 * Grace window applied before an abandoned task's logs are swept. A task is
 * abandoned the instant its lease (or execution deadline) lapses, but a
 * worker's final log flush can arrive slightly afterwards; waiting this long
 * past the expiry clock before purging avoids racing that late flush.
 */
export const ABANDONED_LOG_GRACE_MINUTES = 5;

/** Distinct tasks swept per batch, bounding each iteration's work. */
const DEFAULT_MAX_TASKS_PER_BATCH = 500;

/** Safety cap on batches per invocation so the job can never loop unbounded. */
const DEFAULT_MAX_BATCHES = 50;

export type PurgeAbandonedTaskLogsDeps = {
  logFeedStore: LogFeedStore;
  timeProvider: TimeProvider;
  logger?: Logger | undefined;
  /** Distinct tasks to sweep per batch. Defaults to 500. */
  maxTasksPerBatch?: number | undefined;
  /** Max batches per invocation. Defaults to 50. */
  maxBatches?: number | undefined;
  /** Caller-supplied executor; a fresh transaction is opened per batch when absent. */
  dbExecutor?: DbExecutor | undefined;
};

export type PurgeAbandonedTaskLogsResult = {
  stepsPurged: number;
  linesPurged: number;
};

/**
 * SCHEDULED / BACKGROUND maintenance use case (no auth actor) that cleans up the
 * live log feed for tasks that are effectively `abandoned`. A task is
 * abandoned by inaction — its lease (or execution deadline) lapses — and that
 * status is DERIVED from the clocks, never persisted (see `TaskRunEntity`'s
 * `status` getter). Such tasks never run the completion path, so their hot
 * `task_log_lines` rows are otherwise orphaned forever. Abandoned logs
 * are intentionally NOT archived to object storage — they are simply dropped
 * from Postgres.
 *
 * Because abandonment is no longer persisted (there is no reconcile write and no
 * sweep), this cron is the SOLE collector of orphaned abandoned feeds. It finds
 * its work by reproducing the entity's expiry rule in SQL: a `running` task
 * whose `lease_expires_at` or `execution_deadline_at` lapsed before the grace
 * cutoff, plus legacy rows still persisted as `abandoned` (whose lease was
 * nulled, so they gate on `completed_at`). See
 * {@link LogFeedStore.purgeAbandonedFeeds}.
 *
 * Batched + idempotent: each batch resolves a bounded set of eligible tasks and
 * deletes their rows, looping until a batch reports no progress or the batch cap
 * is hit. A missed or duplicate invocation is harmless. Only tasks whose expiry
 * clock lapsed more than {@link ABANDONED_LOG_GRACE_MINUTES} ago are touched, so
 * a worker's late flush is not raced.
 */
export const purgeAbandonedTaskLogs = async (
  deps: PurgeAbandonedTaskLogsDeps,
): Promise<PurgeAbandonedTaskLogsResult> => {
  const maxTasksPerBatch = deps.maxTasksPerBatch ?? DEFAULT_MAX_TASKS_PER_BATCH;
  const maxBatches = deps.maxBatches ?? DEFAULT_MAX_BATCHES;

  const now = deps.timeProvider.now();
  const cutoff = new Date(
    now.getTime() - ABANDONED_LOG_GRACE_MINUTES * 60 * 1_000,
  );

  const runBatch = async (
    executor: DbExecutor,
  ): Promise<PurgeAbandonedTaskLogsResult> =>
    await deps.logFeedStore.purgeAbandonedFeeds(
      cutoff,
      maxTasksPerBatch,
      executor,
    );

  const executeBatch = async (): Promise<PurgeAbandonedTaskLogsResult> => {
    const executor = deps.dbExecutor;
    if (executor) {
      if ("transaction" in executor) {
        return await executor.transaction(
          async (tx: DbTransaction) => await runBatch(tx),
        );
      }
      // Already inside a transaction — reuse it.
      return await runBatch(executor);
    }
    return await getDb().transaction(async (tx) => await runBatch(tx));
  };

  let totalTasks = 0;
  let totalLines = 0;

  for (let batch = 0; batch < maxBatches; batch++) {
    const { stepsPurged, linesPurged } = await executeBatch();
    totalTasks += stepsPurged;
    totalLines += linesPurged;
    if (stepsPurged === 0) {
      break;
    }
  }

  if (totalTasks > 0) {
    deps.logger?.info(
      {
        stepsPurged: totalTasks,
        linesPurged: totalLines,
        graceMinutes: ABANDONED_LOG_GRACE_MINUTES,
      },
      "Purged log feeds for abandoned tasks",
    );
  }

  return { stepsPurged: totalTasks, linesPurged: totalLines };
};

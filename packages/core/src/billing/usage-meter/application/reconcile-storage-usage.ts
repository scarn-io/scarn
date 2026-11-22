import { defaultPlanId } from "@scarn/core/billing/plan/application/default-plan-id";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor, DbTransaction } from "@scarn/core/lib/db/db-executor";
import type { Logger } from "@scarn/observability/logging";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import type { ArtifactRepo } from "@scarn/core/tasks/task-artifact/application/artifact-repo";
import type { ArtifactFailureRepo } from "@scarn/core/tasks/task-artifact/application/artifact-failure-repo";
import { currentBillingPeriod } from "../domain/billing-period";
import { STORAGE_RETENTION_DAYS } from "../domain/storage-retention";
import type { StorageUsageReader } from "./storage-usage-reader";
import type { UsageMeterRepo } from "./usage-meter-repo";

export type ReconcileStorageUsageDeps = {
  usageMeterRepo: UsageMeterRepo;
  storageUsageReader: StorageUsageReader;
  timeProvider: TimeProvider;
  logger?: Logger | undefined;
  /**
   * Optional task repo. When provided, expired archive columns are
   * nulled out in the SAME transaction so `tasks` rows mirror the
   * lifecycle deletion (the live archive endpoint then 404s for expired
   * archives). Optional so callers that only want the meter corrected can omit
   * it; recommended to supply it for a fully self-healing read path.
   */
  taskRunRepo?: TaskRunRepo | undefined;
  /**
   * Optional artifact repo. When provided, expired artifact columns
   * (objectKey/storeRef/sizeBytes/contentType) are nulled out in the SAME
   * transaction so `task_artifacts` rows mirror the lifecycle
   * deletion (the artifact download-URL endpoint then 404s for expired
   * artifacts). Optional for the same reason as `taskRunRepo` above.
   */
  artifactRepo?: ArtifactRepo | undefined;
  /**
   * Optional artifact-failure repo. When provided, expired upload-failure
   * rows are hard-deleted in the SAME transaction, reusing the same
   * `STORAGE_RETENTION_DAYS` window — failure rows carry no bytes, so there
   * is nothing to null out (unlike `artifactRepo.clearExpiredArtifacts`
   * above), just the row itself. Optional for the same reason as
   * `artifactRepo` above.
   */
  artifactFailureRepo?: ArtifactFailureRepo | undefined;
  /** Caller-supplied executor; a fresh transaction is opened when absent. */
  dbExecutor?: DbExecutor | undefined;
  /**
   * Reconciles only this org: every clear and the meter correction are
   * limited to its projects and its meter row. Every org when absent.
   */
  orgId?: UuidV7 | undefined;
};

export type ReconcileStorageUsageResult = {
  orgsReconciled: number;
};

/**
 * SCHEDULED / BACKGROUND maintenance use case (no auth actor) that keeps each
 * org's `storageBytes` meter accurate as the S3 lifecycle rule (Phase 7) expires
 * old archive objects. Nothing tells the app when lifecycle deletes an object,
 * so this recomputes the retained quantity from the source of truth and corrects
 * the meter.
 *
 * SNAPSHOT vs FLOW: `storageBytes` is a point-in-time RETAINED quantity, so this
 * OVERWRITES it with the recomputed absolute total rather than applying a delta.
 * `writes`/`reads` in the same row are monthly FLOW counters and are left
 * UNTOUCHED — they are independent.
 *
 * Set-based: the meter correction is a single repo call
 * ({@link UsageMeterRepo.reconcileStorageForPeriod}) that runs in a fixed number
 * of statements regardless of org count — both setting retained totals and
 * flooring expired-only orgs to 0 — rather than a per-org read-modify-write
 * loop. This keeps the job's latency flat as org count grows, which matters
 * because it runs from a scheduler (see invocation note below).
 *
 * Invocation note (for Phase 7): there is no scheduler in `packages/core` today.
 * Lease expiry is handled lazily inside the `claim` query (reclaiming rows whose
 * `lease_expires_at` has passed) rather than by a background reaper, so there is
 * no existing cron/sweeper to imitate. Phase 7 should invoke this from whatever
 * scheduler it introduces (e.g. an API-side cron route or a worker tick),
 * constructing it with the Drizzle deps wired in DI as `storageUsageReader` +
 * the existing `usageMeterRepo` / `taskRunRepo`.
 */
export const reconcileStorageUsage = async (
  deps: ReconcileStorageUsageDeps,
): Promise<ReconcileStorageUsageResult> => {
  const run = async (tx: DbExecutor): Promise<ReconcileStorageUsageResult> => {
    const now = deps.timeProvider.now();
    const period = currentBillingPeriod(now);

    // Mirror the lifecycle deletion in the DB first so the read path is correct
    // and so this org sum already excludes the rows we just cleared.
    if (deps.taskRunRepo) {
      const clearedCount = await deps.taskRunRepo.clearExpiredLogArchives(
        now,
        STORAGE_RETENTION_DAYS,
        tx,
        deps.orgId,
      );
      if (clearedCount > 0) {
        deps.logger?.info(
          { clearedCount, retentionDays: STORAGE_RETENTION_DAYS },
          "Cleared expired log archive columns during storage reconciliation",
        );
      }
      const clearedSessions = await deps.taskRunRepo.clearExpiredSessions(
        now,
        STORAGE_RETENTION_DAYS,
        tx,
        deps.orgId,
      );
      if (clearedSessions > 0) {
        deps.logger?.info(
          {
            clearedCount: clearedSessions,
            retentionDays: STORAGE_RETENTION_DAYS,
          },
          "Cleared expired agent session columns during storage reconciliation",
        );
      }
    }

    if (deps.artifactRepo) {
      const clearedCount = await deps.artifactRepo.clearExpiredArtifacts(
        now,
        STORAGE_RETENTION_DAYS,
        tx,
        deps.orgId,
      );
      if (clearedCount > 0) {
        deps.logger?.info(
          { clearedCount, retentionDays: STORAGE_RETENTION_DAYS },
          "Cleared expired artifact columns during storage reconciliation",
        );
      }
    }

    if (deps.artifactFailureRepo) {
      const deletedCount = await deps.artifactFailureRepo.deleteExpiredFailures(
        now,
        STORAGE_RETENTION_DAYS,
        tx,
        deps.orgId,
      );
      if (deletedCount > 0) {
        deps.logger?.info(
          { deletedCount, retentionDays: STORAGE_RETENTION_DAYS },
          "Deleted expired artifact-upload-failure rows during storage reconciliation",
        );
      }
    }

    const rows = await deps.storageUsageReader.sumRetainedBytesByOrg(
      now,
      STORAGE_RETENTION_DAYS,
      tx,
      deps.orgId,
    );

    // New meter rows start on the deployment default plan. One set-based call
    // sets retained totals AND floors expired-only orgs to 0 (see repo method docs).
    const orgsReconciled = await deps.usageMeterRepo.reconcileStorageForPeriod(
      period,
      rows,
      defaultPlanId(),
      tx,
      deps.orgId,
    );

    if (orgsReconciled > 0) {
      deps.logger?.info(
        { orgsReconciled, retainedOrgs: rows.length },
        "Reconciled storage meters against retained archive totals",
      );
    }

    return { orgsReconciled };
  };

  const executor = deps.dbExecutor;
  if (executor) {
    if ("transaction" in executor) {
      return await executor.transaction(
        async (tx: DbTransaction) => await run(tx),
      );
    }
    // Already inside a transaction — reuse it.
    return await run(executor);
  }

  return await getDb().transaction(async (tx) => await run(tx));
};

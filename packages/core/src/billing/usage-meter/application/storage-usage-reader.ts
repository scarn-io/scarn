import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";

/**
 * One org's currently-retained bytes (log archives + artifacts combined), as
 * computed from the source of truth (`app.task_runs.
 * log_archive_size_bytes` and `app.task_artifacts.size_bytes`).
 */
export type OrgRetainedBytes = {
  orgId: UuidV7;
  bytes: number;
};

/**
 * A single org's currently-retained bytes, split by source. Unlike
 * {@link OrgRetainedBytes} (used by the whole-table reconciliation sweep),
 * this is a read-only, single-org breakdown for display purposes (e.g. the
 * usage panel's "Storage" line) — it does not feed `usage_meters.storageBytes`
 * and is never persisted.
 */
export type OrgRetainedBytesBreakdown = {
  artifactBytes: number;
  logBytes: number;
  sessionBytes: number;
};

/**
 * Read model that computes each org's CURRENT total retained bytes (log
 * archives + artifacts) for storage-usage reconciliation. This is a
 * query-only port (no aggregate to rehydrate), so it lives outside
 * {@link UsageMeterRepo}; the Drizzle impl is in `infra/`.
 */
export type StorageUsageReader = {
  /**
   * Sums `log_archive_size_bytes`, `task_artifacts.size_bytes` and
   * `task_runs.session_size_bytes` per owning org over rows that are still
   * considered PRESENT as of `now`. A saved session is present if it has an
   * object key and its run's `completed_at` is inside the `retentionDays`
   * window; sessions with no recorded size count as 0.
   * A log archive is present if it has a store ref and either no archived-at
   * timestamp (legacy rows, treated as present) or one inside the
   * `retentionDays` window. An artifact is present if it has a store ref and
   * its `createdAt` is inside the `retentionDays` window (artifacts have no
   * legacy-null aging column — `createdAt` is always set). Rows aged past the
   * window are treated as lifecycle-deleted and excluded, mirroring the S3
   * expiration rules. Rows whose project has no owning org are excluded (see
   * impl note).
   *
   * Returns one entry per org that has any retained bytes; orgs with zero
   * retained bytes are omitted (the caller does not need a zero row to floor an
   * existing meter — but it MAY: see the use case for how zeroing is handled).
   * Limited to `orgId` when given.
   */
  sumRetainedBytesByOrg(
    now: Date,
    retentionDays: number,
    dbExecutor?: DbExecutor,
    orgId?: UuidV7,
  ): Promise<OrgRetainedBytes[]>;

  /**
   * Same "present" predicate as {@link sumRetainedBytesByOrg} (store ref set +
   * inside the retention window), scoped to ONE org and split by source
   * instead of merged into a single total. Used by the read-only usage-panel
   * breakdown (artifacts vs. log archives), not by reconciliation. Always
   * returns both fields, defaulting an absent source to 0 (no
   * "omit when zero" behavior here — a single-org read has no
   * amortization concern that would motivate a sparse result).
   */
  getRetainedBytesBreakdownForOrg(
    orgId: UuidV7,
    now: Date,
    retentionDays: number,
    dbExecutor?: DbExecutor,
  ): Promise<OrgRetainedBytesBreakdown>;
};

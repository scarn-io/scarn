/**
 * Storage retention policy for archived step-execution logs AND step-execution
 * artifacts. Both object families share the SAME retention window
 * (`STORAGE_RETENTION_DAYS`) by product decision — there is deliberately no
 * separate `ARTIFACT_RETENTION_DAYS` constant.
 *
 * This module is the SINGLE SOURCE OF TRUTH for "how long is an archive/artifact
 * retained before it is considered deleted". Two consumers must agree on it:
 *
 *  1. Reconciliation (this domain, Phase 6 + Phase 2) — excludes archives/
 *     artifacts older than the window when recomputing each org's retained
 *     `storageBytes`, and nulls out their store_ref/size/(archived_at | key)
 *     columns so the `tasks`/`task_artifacts` rows mirror
 *     the deletion.
 *  2. The S3 object lifecycle expiration rules (Phase 7 + Phase 2) — must be
 *     configured to expire objects after EXACTLY `STORAGE_RETENTION_DAYS` so the
 *     bucket and the database converge on the same set of "present" objects.
 *
 * IMPORTANT: when you touch the S3 lifecycle rules, mirror
 * `STORAGE_RETENTION_DAYS` here — do not hard-code a separate number. If the
 * windows diverge, reconciliation will either under-count (bytes the bucket
 * still holds) or over-count (bytes the bucket already expired).
 *
 * WHERE THE LIFECYCLE RULES LIVE:
 *  - SINGLE SOURCE: `taskLifecycleRule()` below is the one place both
 *    rules' shape (prefix, status, expiration days) are defined — it now
 *    returns THREE rules (log archives, artifacts and saved agent sessions)
 *    sharing one retention window. Both consumers below derive from it via `scripts/gen-lifecycle.ts`,
 *    which writes `infra/lifecycle.json`. Never hand-write the rules or the day
 *    count again.
 *  - LOCAL DEV (RustFS): the `rustfs-init` one-shot in the repo-root
 *    `docker-compose.yml` runs `aws s3api put-bucket-lifecycle-configuration`
 *    on the local bucket from the generated `infra/lifecycle.json` (the S3
 *    REST shape this function emits).
 *  - PROD (AWS S3): codified in `infra/` Terraform. The
 *    `aws_s3_bucket_lifecycle_configuration` iterates every rule in the same
 *    generated `infra/lifecycle.json` via `jsondecode`, so the prod lifecycle
 *    windows can never drift from STORAGE_RETENTION_DAYS.
 */

/**
 * Days an archived log object is retained before the lifecycle rule expires it.
 * Pure constant; no IO. Default 30 days.
 */
export const STORAGE_RETENTION_DAYS = 30;

/**
 * Object key prefix the log-archive lifecycle expiration rule targets.
 * Archived step-execution logs are written under this prefix; only they
 * expire under this rule.
 */
export const STEP_EXECUTION_ARCHIVE_PREFIX = "step-executions/";

/**
 * Object key prefix the artifact lifecycle expiration rule targets. Step
 * execution artifacts are written under this prefix (see
 * `deriveArtifactObjectKey`, which builds keys as
 * `artifacts/${projectId}/${taskId}/${relativeStorePath}`); only they
 * expire under this rule.
 */
export const ARTIFACT_ARCHIVE_PREFIX = "artifacts/";

/**
 * Object key prefix for saved agent sessions (`tasks/<taskId>/session.json`,
 * see `taskRunSessionObjectKey`). They are also deleted when their step visit
 * ends; this rule catches anything left behind.
 */
export const TASK_SESSION_PREFIX = "tasks/";

/**
 * Canonical S3 lifecycle configuration for the log-archive bucket, in the S3
 * REST API shape (the shape `aws s3api put-bucket-lifecycle-configuration`
 * consumes and the shape Terraform reads `Expiration.Days` out of). Pure; no
 * IO.
 *
 * Emits THREE rules — log archives, artifacts and saved agent sessions — all
 * driven by the SAME `retentionDays` parameter, since the windows are
 * identical by product decision (there is deliberately no separate artifact
 * retention constant).
 *
 * This is the SINGLE SOURCE for both lifecycle rules. `scripts/gen-lifecycle.ts`
 * serializes the return value to `infra/lifecycle.json`; do not hand-write that
 * file or duplicate the day count anywhere.
 */
export const taskLifecycleRule = (
  retentionDays: number = STORAGE_RETENTION_DAYS,
) => ({
  Rules: [
    {
      ID: "expire-step-execution-archives",
      Status: "Enabled" as const,
      Filter: { Prefix: STEP_EXECUTION_ARCHIVE_PREFIX },
      Expiration: { Days: retentionDays },
    },
    {
      ID: "expire-step-execution-artifacts",
      Status: "Enabled" as const,
      Filter: { Prefix: ARTIFACT_ARCHIVE_PREFIX },
      Expiration: { Days: retentionDays },
    },
    {
      ID: "expire-task-sessions",
      Status: "Enabled" as const,
      Filter: { Prefix: TASK_SESSION_PREFIX },
      Expiration: { Days: retentionDays },
    },
  ],
});

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

/**
 * Pure predicate: has an archive written at `archivedAt` aged past the retention
 * window as of `now`? An archive is expired once `now - archivedAt` strictly
 * exceeds `retentionDays`. Mirrors the deterministic boundary the S3 lifecycle
 * rule applies (object age > N days => expired).
 *
 * Depends only on its arguments; performs no IO.
 */
export const isArchiveExpired = (
  archivedAt: Date,
  now: Date,
  retentionDays: number = STORAGE_RETENTION_DAYS,
): boolean => {
  const ageMs = now.getTime() - archivedAt.getTime();
  return ageMs > retentionDays * MS_PER_DAY;
};

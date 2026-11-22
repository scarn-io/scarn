import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { ProjectPermission } from "@scarn/core/projects/project/domain/project-permission";
import type { TaskRunEntity } from "../domain/task-run-entity";

export type TaskRunRepo = {
  load(id: UuidV7, dbExecutor?: DbExecutor): Promise<TaskRunEntity | null>;
  /**
   * `load` with the run row locked until the transaction ends, so a worker
   * report racing a chat's Delete waits for it and then finds no run.
   */
  lock(id: UuidV7, dbExecutor: DbExecutor): Promise<TaskRunEntity | null>;
  /**
   * The runs of the Task whose conversation is `conversationId`, oldest
   * first, their rows locked until the transaction ends. Taken before the
   * Task's own lock, the order worker calls (claim, yield, complete) take.
   */
  lockByConversationId(
    conversationId: UuidV7,
    dbExecutor: DbExecutor,
  ): Promise<TaskRunEntity[]>;
  listByProjectId(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<TaskRunEntity[]>;
  /** A Task's runs, oldest first (by `number`). */
  listByTaskId(
    taskId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<TaskRunEntity[]>;
  /**
   * Batch-loads tasks by id, in one `IN`-scoped query. No ordering
   * guarantee; fewer entities than ids are returned when some ids don't
   * exist.
   */
  loadManyByIds(
    ids: UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<TaskRunEntity[]>;
  /**
   * The front of a project's claim queue: `queued` Tasks plus `running` ones
   * whose lease or deadline has passed, which the claim path fails first.
   */
  loadClaimableByProjectId(
    projectId: UuidV7,
    limit: number,
    now: Date,
    dbExecutor?: DbExecutor,
    workItemId?: string,
  ): Promise<TaskRunEntity[]>;
  create(task: TaskRunEntity, dbExecutor?: DbExecutor): Promise<TaskRunEntity>;
  claim(
    taskRunId: UuidV7,
    claim: {
      workerId: string;
      claimedByUserId: UuidV7;
      claimToken: string;
      claimedAt: Date;
      startedAt: Date;
      leaseExpiresAt: Date;
      executionDeadlineAt?: Date | null | undefined;
    },
    dbExecutor?: DbExecutor,
  ): Promise<TaskRunEntity | null>;
  /**
   * Atomically claims up to `batchSize` `queued` tasks for a
   * project in ONE statement (`UPDATE ... FROM (SELECT ... FOR UPDATE SKIP
   * LOCKED LIMIT batchSize) ... RETURNING`), replacing the old
   * "over-fetch + per-candidate optimistic `claim()`" pattern (see
   * `docs/plans/claim-step-executions-batching.md`, Phase 3). `SKIP LOCKED`
   * handles concurrent-worker races at the row-lock level — two concurrent
   * `claimBatch` calls never return overlapping ids. Each claimed row gets
   * its own random `claimToken`. A row whose `executionDeadlineAt` has
   * already passed is never claimed (excluded by this method's own `WHERE`,
   * independent of any caller-side timeout detection). `executionDeadlineAt`
   * for a row with no existing deadline but a configured
   * `executionTimeoutSeconds` is computed in SQL to agree with
   * `buildExecutionDeadlineAt` (`task-claim-helpers.ts`) for the
   * same inputs. The lease is the Task's `heartbeatSeconds` when set, else
   * `leaseDurationSeconds`. Returns the actually-claimed entities — fewer than
   * `batchSize` if fewer were available/lockable — in one batched
   * `loadManyFromRows` call regardless of how many rows were claimed.
   */
  claimBatch(
    projectId: UuidV7,
    batchSize: number,
    now: Date,
    workerId: string,
    claimedByUserId: UuidV7,
    leaseDurationSeconds: number,
    dbExecutor?: DbExecutor,
    workItemId?: string,
  ): Promise<TaskRunEntity[]>;
  /**
   * Sets the run's `baseCommit`, and its `baseBranch` when given, only where
   * each is still null, while `claimToken` holds the running claim. Returns
   * the stored values afterwards; null when the claim doesn't hold.
   */
  pinBaseCommit(
    taskRunId: UuidV7,
    claimToken: string,
    pin: { baseCommit: string; baseBranch: string | null; now: Date },
    dbExecutor?: DbExecutor,
  ): Promise<{ baseCommit: string; baseBranch: string | null } | null>;
  /**
   * Sets the run's `environmentVersionId` to `versionId` only where it is
   * still `replacing` (null by default, so the first write wins). Returns the
   * stored value afterwards; null when the run doesn't exist.
   */
  pinEnvironmentVersion(
    taskRunId: UuidV7,
    versionId: UuidV7,
    replacing?: UuidV7 | null,
    dbExecutor?: DbExecutor,
  ): Promise<UuidV7 | null>;
  /**
   * Extends the lease of a run `claimToken` still holds: running, lease and
   * execution deadline both after `now`. The lease is the Task's
   * `heartbeatSeconds` when set, else `leaseDurationSeconds`. With `member`,
   * also requires that user's project membership to grant `permission`, so a
   * caller can authorize and heartbeat in one statement. Returns the updated
   * run; null when any condition fails.
   */
  heartbeat(
    taskRunId: UuidV7,
    claimToken: string,
    heartbeat: {
      now: Date;
      leaseDurationSeconds: number;
      member?: { userId: UuidV7; permission: ProjectPermission } | undefined;
    },
    dbExecutor?: DbExecutor,
  ): Promise<TaskRunEntity | null>;
  /**
   * `reload` (default `true`) controls whether the write reads its own row(s)
   * back after the upsert. Pass `false` only when the caller already holds
   * an entity it trusts to be accurate post-write (e.g. it was loaded fresh
   * moments earlier and only locally mutated) and never reads the return
   * value for anything beyond "the write didn't throw" — in that mode `save`
   * returns the *input* entity unchanged, skipping the "did we get a row
   * back" `PersistenceError` check, and `saveMany` returns `[]`.
   */
  save(
    task: TaskRunEntity,
    dbExecutor?: DbExecutor,
    reload?: boolean,
  ): Promise<TaskRunEntity>;
  saveMany(
    tasks: TaskRunEntity[],
    dbExecutor?: DbExecutor,
    reload?: boolean,
  ): Promise<TaskRunEntity[]>;
  /**
   * Persist the object-storage location + size of the finalized log archive
   * for a task. Set after the live feed is flushed to durable storage.
   */
  setLogArchive(
    taskRunId: UuidV7,
    archive: { storeRef: string; sizeBytes: number },
    dbExecutor?: DbExecutor,
  ): Promise<void>;
  /**
   * Read the finalized log archive metadata, or null when no archive exists yet
   * (the step has not completed, or had no logs).
   */
  getLogArchive(
    taskRunId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<{ storeRef: string; sizeBytes: number } | null>;
  /**
   * Null out the archive columns (`log_archive_store_ref`,
   * `log_archive_size_bytes`, `log_archived_at`) for every task whose
   * archive has aged past the retention window as of `now` (archived-at strictly
   * older than `now - retentionDays`). This mirrors the S3 lifecycle deletion in
   * the database so the live archive endpoint 404s for expired archives and so a
   * subsequent reconciliation no longer counts them. Returns the number of rows
   * cleared. Idempotent: already-cleared rows (null store ref) are skipped.
   * Limited to `orgId`'s projects when given.
   */
  clearExpiredLogArchives(
    now: Date,
    retentionDays: number,
    dbExecutor?: DbExecutor,
    orgId?: UuidV7,
  ): Promise<number>;
  /**
   * Null out `session_object_key` and `session_size_bytes` on the given runs,
   * so they stop being restored and counted. Does not touch object storage.
   */
  clearSessions(ids: UuidV7[], dbExecutor?: DbExecutor): Promise<void>;
  /**
   * Null out the session columns of every run whose saved session has aged
   * past the retention window as of `now` (`completed_at` at or before
   * `now - retentionDays`), mirroring the `tasks/` lifecycle rule. Returns
   * the number of rows cleared. Limited to `orgId`'s projects when given.
   */
  clearExpiredSessions(
    now: Date,
    retentionDays: number,
    dbExecutor?: DbExecutor,
    orgId?: UuidV7,
  ): Promise<number>;
  /**
   * Deletes the given runs outright, cascading (via FK
   * `onDelete: "cascade"`) to their log lines, artifacts and artifact
   * resolutions. Leaves their Tasks in place (see
   * `TaskRepo.deleteMany`). Does not touch object storage: any artifact bodies
   * already written there are left behind. Returns the number of runs
   * actually deleted.
   */
  deleteMany(ids: UuidV7[], dbExecutor?: DbExecutor): Promise<number>;
  /**
   * `deleteMany` for every run in the project, pipeline-linked or not.
   */
  deleteByProjectId(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<number>;
};

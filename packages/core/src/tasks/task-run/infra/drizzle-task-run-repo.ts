/* eslint-disable max-lines */
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { projectInOrg } from "@scarn/core/lib/db/project-in-org";
import {
  systemTimeProvider,
  type TimeProvider,
} from "@scarn/core/lib/time-provider";
import { projectMemberships, taskRuns, tasks } from "@scarn/core/lib/db/schema";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { PersistenceError } from "@scarn/core/lib/errors";
import {
  readRowsSkippingUnreadable,
  type StoredReadResult,
} from "@scarn/core/lib/db/stored-json";
import { noopLogger, type Logger } from "@scarn/observability/logging";
import { readStoredTaskInstructions } from "@scarn/core/tasks/task/contracts/task-stored";
import type { ProjectPermission } from "@scarn/core/projects/project/domain/project-permission";
import { rolesGrantingPermission } from "@scarn/core/projects/project/domain/project-role";
import type { TaskRunRepo } from "../application/task-run-repo";
import { TaskRunEntity, type TaskRunRowProps } from "../domain/task-run-entity";
import { previousTaskRunIdSql } from "./previous-task-run-id-sql";
import { readStoredTaskRun } from "../contracts/task-run-stored";

/**
 * A `task_runs` row with the instructions it runs, read from its Task. The
 * run entity carries them read-only; writes touch only `task_runs`.
 */
const taskInstructionColumns = {
  kind: tasks.kind,
  name: tasks.name,
  prompt: tasks.prompt,
  entrypointJson: tasks.entrypointJson,
  toolCallJson: tasks.toolCallJson,
  resultSchemaJson: tasks.resultSchemaJson,
  taskExecutionConfigId: tasks.taskExecutionConfigId,
  inputJson: tasks.inputJson,
  heartbeatSeconds: tasks.heartbeatSeconds,
  executionTimeoutSeconds: tasks.executionTimeoutSeconds,
  schemaVersion: tasks.schemaVersion,
};

const taskRunSelection = {
  run: taskRuns,
  task: taskInstructionColumns,
  previousTaskRunId: previousTaskRunIdSql,
};

type TaskRunSelectRow = {
  run: typeof taskRuns.$inferSelect;
  previousTaskRunId: string | null;
  task: {
    kind: (typeof tasks.$inferSelect)["kind"];
    name: string | null;
    prompt: string | null;
    entrypointJson: unknown;
    toolCallJson: unknown;
    resultSchemaJson: unknown;
    taskExecutionConfigId: string | null;
    inputJson: unknown;
    heartbeatSeconds: number | null;
    executionTimeoutSeconds: number | null;
    schemaVersion: number;
  };
};

/**
 * Reads a run row and its Task's instructions through their stored readers
 * (`readStoredTaskRun`, `readStoredTaskInstructions`), or explains why the
 * row is unreadable.
 */
const readTaskRunRow = (
  { run: row, task, previousTaskRunId }: TaskRunSelectRow,
  evaluatedAt: Date,
): StoredReadResult<TaskRunEntity> => {
  const instructions = readStoredTaskInstructions(task.schemaVersion, task);
  if (!instructions.success) {
    return {
      success: false,
      reason: `task ${row.taskId}: ${instructions.reason}`,
    };
  }
  const stored = readStoredTaskRun(row);
  if (!stored.success) {
    return stored;
  }
  return {
    success: true,
    value: TaskRunEntity.rehydrate({
      id: row.id as TaskRunRowProps["id"],
      taskId: parseUuidV7(row.taskId),
      number: row.number,
      reason: row.reason,
      projectId: row.projectId as TaskRunRowProps["projectId"],
      workItemId: row.workItemId as TaskRunRowProps["workItemId"],
      taskExecutionConfigId:
        task.taskExecutionConfigId === null
          ? null
          : parseUuidV7(task.taskExecutionConfigId),
      name: task.name,
      kind: task.kind,
      prompt: task.prompt,
      resultSchemaJson: instructions.value.resultSchemaJson,
      entrypointJson: instructions.value.entrypointJson,
      toolCallJson: instructions.value.toolCallJson,
      previousTaskRunId:
        previousTaskRunId === null ? null : parseUuidV7(previousTaskRunId),
      baseBranch: row.baseBranch,
      baseCommit: row.baseCommit,
      environmentVersionId:
        row.environmentVersionId === null
          ? null
          : parseUuidV7(row.environmentVersionId),
      heartbeatSeconds: task.heartbeatSeconds,
      status: row.status,
      evaluatedAt,
      inputJson: instructions.value.inputJson,
      claimedBy: row.claimedBy,
      claimedByUserId: row.claimedByUserId,
      claimToken: row.claimToken,
      claimedAt: row.claimedAt,
      lastHeartbeatAt: row.lastHeartbeatAt,
      leaseExpiresAt: row.leaseExpiresAt,
      executionTimeoutSeconds: task.executionTimeoutSeconds,
      executionDeadlineAt: row.executionDeadlineAt,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      resultJson: stored.value.resultJson,
      errorJson: stored.value.errorJson,
      workBranch: row.workBranch,
      createdFromBranch: row.createdFromBranch,
      sessionObjectKey: row.sessionObjectKey,
      sessionSizeBytes: row.sessionSizeBytes,
      sessionRestored: row.sessionRestored,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }),
  };
};

/** The log fields that identify a skipped run row. */
const describeTaskRunRow = ({ run }: TaskRunSelectRow) => ({
  table: "task_runs",
  taskRunId: run.id,
  taskId: run.taskId,
  projectId: run.projectId,
});

// The repo persists `persistedStatus`, the raw column value — NEVER the derived
// `status` getter. `status` applies the read-time liveness overlay
// (timeout/abandoned) and must never reach a write: saving it would burn a
// terminal transition (e.g. persist `abandoned` over a step that actually
// `succeeded`), corrupting data on every write path, not just reads.
const toTaskRow = (task: TaskRunEntity) => ({
  id: task.id,
  taskId: task.taskId,
  number: task.number,
  reason: task.reason,
  projectId: task.projectId,
  workItemId: task.workItemId,
  status: task.persistedStatus,
  resultJson: task.resultJson,
  errorJson: task.errorJson,
  sessionObjectKey: task.sessionObjectKey,
  sessionSizeBytes: task.sessionSizeBytes,
  sessionRestored: task.sessionRestored,
  baseBranch: task.baseBranch,
  baseCommit: task.baseCommit,
  environmentVersionId: task.environmentVersionId,
  workBranch: task.workBranch,
  createdFromBranch: task.createdFromBranch,
  claimedBy: task.claimedBy,
  claimedByUserId: task.claimedByUserId,
  claimToken: task.claimToken,
  claimedAt: task.claimedAt,
  lastHeartbeatAt: task.lastHeartbeatAt,
  leaseExpiresAt: task.leaseExpiresAt,
  executionDeadlineAt: task.executionDeadlineAt,
  startedAt: task.startedAt,
  completedAt: task.completedAt,
  createdAt: task.createdAt ?? new Date(),
  updatedAt: task.updatedAt ?? new Date(),
});

export class DrizzleTaskRunRepo implements TaskRunRepo {
  // The clock the entity's derived `status` getter is evaluated against.
  // Rehydration stamps every entity with `evaluatedAt = timeProvider.now()`, so
  // a step whose lease/deadline has lapsed reports `abandoned`/`timeout` without
  // any caller having to know that clocks exist.
  private readonly timeProvider: TimeProvider;

  private readonly logger: Logger;

  constructor(
    timeProvider: TimeProvider = systemTimeProvider,
    logger: Logger = noopLogger,
  ) {
    this.timeProvider = timeProvider;
    this.logger = logger;
  }

  /** A single read: an unreadable row throws `TASK_RUN_ROW_UNREADABLE`. */
  private toEntity(row: TaskRunSelectRow): TaskRunEntity {
    const read = readTaskRunRow(row, this.timeProvider.now());
    if (!read.success) {
      throw new PersistenceError(
        `Task run ${row.run.id} is unreadable: ${read.reason}`,
        "TASK_RUN_ROW_UNREADABLE",
      );
    }
    return read.value;
  }

  /** A bulk read: an unreadable row is logged and left out. */
  private loadManyFromRows(rows: TaskRunSelectRow[]): TaskRunEntity[] {
    const evaluatedAt = this.timeProvider.now();
    return readRowsSkippingUnreadable(
      rows,
      (row) => readTaskRunRow(row, evaluatedAt),
      this.logger,
      describeTaskRunRow,
    );
  }

  private selectRuns(db: DbExecutor) {
    return db
      .select(taskRunSelection)
      .from(taskRuns)
      .innerJoin(tasks, eq(tasks.id, taskRuns.taskId));
  }

  async load(id: TaskRunRowProps["id"], dbExecutor?: DbExecutor) {
    const db = dbExecutor ?? getDb();
    const [row] = await this.selectRuns(db).where(eq(taskRuns.id, id)).limit(1);

    if (!row) {
      return null;
    }

    return this.toEntity(row);
  }

  async listByProjectId(
    projectId: TaskRunRowProps["projectId"],
    dbExecutor?: DbExecutor,
  ) {
    const db = dbExecutor ?? getDb();
    const rows = await this.selectRuns(db).where(
      eq(taskRuns.projectId, projectId),
    );

    return this.loadManyFromRows(rows);
  }

  async listByTaskId(taskId: UuidV7, dbExecutor?: DbExecutor) {
    const db = dbExecutor ?? getDb();
    const rows = await this.selectRuns(db)
      .where(eq(taskRuns.taskId, taskId))
      .orderBy(asc(taskRuns.number));

    return this.loadManyFromRows(rows);
  }

  async lock(id: UuidV7, dbExecutor: DbExecutor) {
    const [locked] = await dbExecutor
      .select({ id: taskRuns.id })
      .from(taskRuns)
      .where(eq(taskRuns.id, id))
      .for("update");

    return locked ? await this.load(id, dbExecutor) : null;
  }

  async lockByConversationId(conversationId: UuidV7, dbExecutor: DbExecutor) {
    const locked = await dbExecutor
      .select({ id: taskRuns.id })
      .from(taskRuns)
      .where(
        inArray(
          taskRuns.taskId,
          dbExecutor
            .select({ id: tasks.id })
            .from(tasks)
            .where(eq(tasks.conversationId, conversationId)),
        ),
      )
      .orderBy(asc(taskRuns.number))
      .for("update");
    if (locked.length === 0) {
      return [];
    }
    const rows = await this.selectRuns(dbExecutor)
      .where(
        inArray(
          taskRuns.id,
          locked.map((row) => row.id),
        ),
      )
      .orderBy(asc(taskRuns.number));

    return this.loadManyFromRows(rows);
  }

  async loadManyByIds(ids: UuidV7[], dbExecutor?: DbExecutor) {
    if (ids.length === 0) {
      return [];
    }
    const db = dbExecutor ?? getDb();
    const rows = await this.selectRuns(db).where(inArray(taskRuns.id, ids));

    return this.loadManyFromRows(rows);
  }

  async loadClaimableByProjectId(
    projectId: TaskRunRowProps["projectId"],
    limit: number,
    now: Date,
    dbExecutor?: DbExecutor,
    workItemId?: string,
  ) {
    const db = dbExecutor ?? getDb();
    const safeLimit = Math.max(1, Math.min(limit, 100));

    const rows = await this.selectRuns(db)
      .where(
        and(
          eq(taskRuns.projectId, projectId),
          or(
            eq(taskRuns.status, "queued"),
            and(
              eq(taskRuns.status, "running"),
              or(
                lte(taskRuns.leaseExpiresAt, now),
                lte(taskRuns.executionDeadlineAt, now),
              ),
            ),
          ),
          workItemId ? eq(taskRuns.workItemId, workItemId) : undefined,
        ),
      )
      .orderBy(asc(taskRuns.createdAt), asc(taskRuns.id))
      .limit(safeLimit);

    return this.loadManyFromRows(rows);
  }

  async create(task: TaskRunEntity, dbExecutor?: DbExecutor) {
    const db = dbExecutor ?? getDb();
    await db.insert(taskRuns).values(toTaskRow(task));

    const createdTask = await this.load(task.id, dbExecutor);
    if (!createdTask) {
      throw new PersistenceError(
        `Failed to create task ${task.id}`,
        "TASK_CREATE_FAILED",
      );
    }

    return createdTask;
  }

  async claim(
    taskRunId: TaskRunRowProps["id"],
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
  ) {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .update(taskRuns)
      .set({
        status: "running",
        claimedBy: claim.workerId,
        claimedByUserId: claim.claimedByUserId,
        claimToken: claim.claimToken,
        claimedAt: claim.claimedAt,
        lastHeartbeatAt: claim.claimedAt,
        leaseExpiresAt: claim.leaseExpiresAt,
        executionDeadlineAt: claim.executionDeadlineAt ?? null,
        startedAt: claim.startedAt,
        completedAt: null,
        updatedAt: claim.claimedAt,
      })
      .where(
        and(
          eq(taskRuns.id, taskRunId),
          or(
            eq(taskRuns.status, "queued"),
            and(
              eq(taskRuns.status, "running"),
              lt(taskRuns.leaseExpiresAt, claim.claimedAt),
            ),
          ),
          or(
            isNull(taskRuns.executionDeadlineAt),
            gt(taskRuns.executionDeadlineAt, claim.claimedAt),
          ),
        ),
      )
      .returning({ id: taskRuns.id });

    if (!row) {
      return null;
    }

    return this.load(parseUuidV7(row.id), db);
  }

  async claimBatch(
    projectId: TaskRunRowProps["projectId"],
    batchSize: number,
    now: Date,
    workerId: string,
    claimedByUserId: UuidV7,
    leaseDurationSeconds: number,
    dbExecutor?: DbExecutor,
    workItemId?: string,
  ): Promise<TaskRunEntity[]> {
    const db = dbExecutor ?? getDb();
    const safeBatchSize = Math.max(1, Math.min(batchSize, 100));
    const boundNow = sql`${now.toISOString()}::timestamptz`;

    const workItemScope = workItemId
      ? sql`and ${taskRuns.workItemId} = ${workItemId}`
      : sql``;

    // One atomic statement (decision 6, `docs/plans/claim-step-executions-batching.md`):
    // `SKIP LOCKED` on the candidate subquery's row lock replaces the old
    // per-candidate transaction + optimistic-retry-via-over-fetch pattern —
    // two concurrent `claimBatch` calls never return overlapping ids. The
    // candidate subquery's own `WHERE` independently excludes
    // deadline-passed rows (decision 7): correctness here does not depend on
    // any caller-side timeout-detection query seeing the same rows.
    //
    // `execution_deadline_at`'s `case` branch reproduces
    // `buildExecutionDeadlineAt` (`task-claim-helpers.ts`) in SQL
    // rather than sharing the TS implementation — see this repo's own unit
    // test asserting the two agree for the same inputs (decision 6's
    // regression guard, the same "two implementations of one rule must
    // agree" pattern). The lease is the Task's own `heartbeat_seconds` when
    // set, else the worker's requested duration (`leaseSecondsFor`).
    const rows = await db.execute<{ id: string }>(sql`
      update ${taskRuns} as se
      set
        status = 'running',
        claimed_by = ${workerId},
        claimed_by_user_id = ${claimedByUserId}::uuid,
        claim_token = gen_random_uuid()::text,
        claimed_at = ${boundNow},
        last_heartbeat_at = ${boundNow},
        lease_expires_at = ${boundNow} + make_interval(
          secs => coalesce(candidate.heartbeat_seconds, ${leaseDurationSeconds})
        ),
        started_at = coalesce(candidate.started_at, ${boundNow}),
        execution_deadline_at = coalesce(
          candidate.execution_deadline_at,
          case
            when candidate.execution_timeout_seconds is not null
              then coalesce(candidate.started_at, ${boundNow})
                + make_interval(secs => candidate.execution_timeout_seconds)
            else null
          end
        ),
        completed_at = null,
        updated_at = ${boundNow}
      from (
        select ${taskRuns.id} as id,
          ${tasks.executionTimeoutSeconds} as execution_timeout_seconds,
          ${taskRuns.executionDeadlineAt} as execution_deadline_at,
          ${taskRuns.startedAt} as started_at,
          ${tasks.heartbeatSeconds} as heartbeat_seconds
        from ${taskRuns}
        inner join ${tasks} on ${tasks.id} = ${taskRuns.taskId}
        where ${taskRuns.projectId} = ${projectId}
          and ${taskRuns.status} = 'queued'
          and (
            ${taskRuns.executionDeadlineAt} is null
            or ${taskRuns.executionDeadlineAt} > ${boundNow}
          )
          ${workItemScope}
        order by ${taskRuns.createdAt} asc, ${taskRuns.id} asc
        limit ${safeBatchSize}
        for update of task_runs skip locked
      ) as candidate
      where se.id = candidate.id
      returning se.id
    `);

    const ids = rows.rows.map((row) => parseUuidV7(row.id));
    const loaded = new Map(
      (await this.loadManyByIds(ids, db)).map((task) => [task.id, task]),
    );
    return ids.flatMap((id) => {
      const task = loaded.get(id);
      return task ? [task] : [];
    });
  }

  async pinBaseCommit(
    taskRunId: TaskRunRowProps["id"],
    claimToken: string,
    pin: { baseCommit: string; baseBranch: string | null; now: Date },
    dbExecutor?: DbExecutor,
  ) {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .update(taskRuns)
      .set({
        baseCommit: sql`coalesce(${taskRuns.baseCommit}, ${pin.baseCommit})`,
        baseBranch: sql`coalesce(${taskRuns.baseBranch}, ${pin.baseBranch})`,
        updatedAt: pin.now,
      })
      .where(
        and(
          eq(taskRuns.id, taskRunId),
          eq(taskRuns.status, "running"),
          eq(taskRuns.claimToken, claimToken),
        ),
      )
      .returning({
        baseCommit: taskRuns.baseCommit,
        baseBranch: taskRuns.baseBranch,
      });
    return row?.baseCommit
      ? { baseCommit: row.baseCommit, baseBranch: row.baseBranch }
      : null;
  }

  async pinEnvironmentVersion(
    taskRunId: TaskRunRowProps["id"],
    versionId: UuidV7,
    replacing: UuidV7 | null = null,
    dbExecutor?: DbExecutor,
  ) {
    const db = dbExecutor ?? getDb();
    const stored =
      replacing === null
        ? sql`coalesce(${taskRuns.environmentVersionId}, ${versionId})`
        : sql`case when ${taskRuns.environmentVersionId} = ${replacing} then ${versionId}::uuid else ${taskRuns.environmentVersionId} end`;
    const [row] = await db
      .update(taskRuns)
      .set({ environmentVersionId: stored })
      .where(eq(taskRuns.id, taskRunId))
      .returning({ environmentVersionId: taskRuns.environmentVersionId });
    return row?.environmentVersionId
      ? parseUuidV7(row.environmentVersionId)
      : null;
  }

  async heartbeat(
    taskRunId: TaskRunRowProps["id"],
    claimToken: string,
    {
      now,
      leaseDurationSeconds,
      member,
    }: {
      now: Date;
      leaseDurationSeconds: number;
      member?: { userId: UuidV7; permission: ProjectPermission } | undefined;
    },
    dbExecutor?: DbExecutor,
  ) {
    const db = dbExecutor ?? getDb();
    const boundNow = sql`${now.toISOString()}::timestamptz`;
    const [row] = await db
      .update(taskRuns)
      .set({
        lastHeartbeatAt: now,
        leaseExpiresAt: sql`${boundNow} + make_interval(secs => coalesce(${tasks.heartbeatSeconds}, ${leaseDurationSeconds}))`,
        updatedAt: now,
      })
      .from(tasks)
      .where(
        and(
          eq(taskRuns.id, taskRunId),
          eq(tasks.id, taskRuns.taskId),
          eq(taskRuns.status, "running"),
          eq(taskRuns.claimToken, claimToken),
          or(isNull(taskRuns.leaseExpiresAt), gt(taskRuns.leaseExpiresAt, now)),
          or(
            isNull(taskRuns.executionDeadlineAt),
            gt(taskRuns.executionDeadlineAt, now),
          ),
          member
            ? sql`exists (
                select 1 from ${projectMemberships}
                where ${projectMemberships.projectId} = ${taskRuns.projectId}
                  and ${projectMemberships.userId} = ${member.userId}
                  and ${inArray(projectMemberships.role, rolesGrantingPermission(member.permission))}
              )`
            : undefined,
        ),
      )
      .returning(taskRunSelection);

    return row ? this.toEntity(row) : null;
  }

  async save(task: TaskRunEntity, dbExecutor?: DbExecutor, reload = true) {
    const [savedTask] = await this.saveMany([task], dbExecutor, reload);
    if (!reload) {
      // The caller opted out of the reload — trust the write (it would have
      // thrown on a real failure) and hand back the input unchanged rather
      // than the (deliberately empty) `saveMany` result.
      return task;
    }
    if (!savedTask) {
      throw new PersistenceError(
        `Failed to save task ${task.id}`,
        "TASK_SAVE_FAILED",
      );
    }

    return savedTask;
  }

  async saveMany(
    taskEntities: TaskRunEntity[],
    dbExecutor?: DbExecutor,
    reload = true,
  ): Promise<TaskRunEntity[]> {
    if (taskEntities.length === 0) {
      return [];
    }

    const db = dbExecutor ?? getDb();
    await db
      .insert(taskRuns)
      .values(taskEntities.map((task) => toTaskRow(task)))
      .onConflictDoUpdate({
        target: taskRuns.id,
        set: {
          taskId: sql.raw(`excluded.${taskRuns.taskId.name}`),
          number: sql.raw(`excluded.${taskRuns.number.name}`),
          reason: sql.raw(`excluded.${taskRuns.reason.name}`),
          projectId: sql.raw(`excluded.${taskRuns.projectId.name}`),
          workItemId: sql.raw(`excluded.${taskRuns.workItemId.name}`),
          status: sql.raw(`excluded.${taskRuns.status.name}`),
          resultJson: sql.raw(`excluded.${taskRuns.resultJson.name}`),
          errorJson: sql.raw(`excluded.${taskRuns.errorJson.name}`),
          sessionObjectKey: sql.raw(
            `excluded.${taskRuns.sessionObjectKey.name}`,
          ),
          sessionSizeBytes: sql.raw(
            `excluded.${taskRuns.sessionSizeBytes.name}`,
          ),
          sessionRestored: sql.raw(`excluded.${taskRuns.sessionRestored.name}`),
          baseBranch: sql.raw(`excluded.${taskRuns.baseBranch.name}`),
          baseCommit: sql.raw(`excluded.${taskRuns.baseCommit.name}`),
          environmentVersionId: sql.raw(
            `coalesce(task_runs.${taskRuns.environmentVersionId.name}, excluded.${taskRuns.environmentVersionId.name})`,
          ),
          workBranch: sql.raw(`excluded.${taskRuns.workBranch.name}`),
          createdFromBranch: sql.raw(
            `excluded.${taskRuns.createdFromBranch.name}`,
          ),
          claimedBy: sql.raw(`excluded.${taskRuns.claimedBy.name}`),
          claimedByUserId: sql.raw(`excluded.${taskRuns.claimedByUserId.name}`),
          claimToken: sql.raw(`excluded.${taskRuns.claimToken.name}`),
          claimedAt: sql.raw(`excluded.${taskRuns.claimedAt.name}`),
          lastHeartbeatAt: sql.raw(`excluded.${taskRuns.lastHeartbeatAt.name}`),
          leaseExpiresAt: sql.raw(`excluded.${taskRuns.leaseExpiresAt.name}`),
          executionDeadlineAt: sql.raw(
            `excluded.${taskRuns.executionDeadlineAt.name}`,
          ),
          startedAt: sql.raw(`excluded.${taskRuns.startedAt.name}`),
          completedAt: sql.raw(`excluded.${taskRuns.completedAt.name}`),
          createdAt: sql.raw(`task_runs.${taskRuns.createdAt.name}`),
          updatedAt: sql.raw(`excluded.${taskRuns.updatedAt.name}`),
        },
      });

    if (!reload) {
      return [];
    }

    const ids = taskEntities.map((task) => task.id);
    const rows = await this.selectRuns(db).where(inArray(taskRuns.id, ids));
    const loaded = this.loadManyFromRows(rows);
    const loadedById = new Map(loaded.map((task) => [task.id, task]));

    return ids.flatMap((id) => {
      const task = loadedById.get(id);
      return task ? [task] : [];
    });
  }

  async setLogArchive(
    taskRunId: UuidV7,
    archive: { storeRef: string; sizeBytes: number },
    dbExecutor?: DbExecutor,
  ): Promise<void> {
    const db = dbExecutor ?? getDb();
    const now = new Date();
    await db
      .update(taskRuns)
      .set({
        logArchiveStoreRef: archive.storeRef,
        logArchiveSizeBytes: archive.sizeBytes,
        // Stamp when the archive was written so billing reconciliation can age
        // it against the S3 lifecycle window without querying object storage.
        logArchivedAt: now,
        updatedAt: now,
      })
      .where(eq(taskRuns.id, taskRunId));
  }

  async getLogArchive(
    taskRunId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<{ storeRef: string; sizeBytes: number } | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select({
        storeRef: taskRuns.logArchiveStoreRef,
        sizeBytes: taskRuns.logArchiveSizeBytes,
      })
      .from(taskRuns)
      .where(eq(taskRuns.id, taskRunId));
    if (!row || row.storeRef === null) {
      return null;
    }
    return { storeRef: row.storeRef, sizeBytes: row.sizeBytes ?? 0 };
  }

  async clearExpiredLogArchives(
    now: Date,
    retentionDays: number,
    dbExecutor?: DbExecutor,
    orgId?: UuidV7,
  ): Promise<number> {
    const db = dbExecutor ?? getDb();
    const cutoff = new Date(
      now.getTime() - retentionDays * 24 * 60 * 60 * 1_000,
    );

    // Only rows with a non-null archived-at strictly older than the cutoff are
    // expired. Legacy rows (null archived-at) are left untouched — we cannot
    // age them, and reconciliation already treats them as present.
    const cleared = await db
      .update(taskRuns)
      .set({
        logArchiveStoreRef: null,
        logArchiveSizeBytes: null,
        logArchivedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          isNotNull(taskRuns.logArchiveStoreRef),
          isNotNull(taskRuns.logArchivedAt),
          lte(taskRuns.logArchivedAt, cutoff),
          projectInOrg(taskRuns.projectId, orgId),
        ),
      )
      .returning({ id: taskRuns.id });

    return cleared.length;
  }

  async clearSessions(ids: UuidV7[], dbExecutor?: DbExecutor): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const db = dbExecutor ?? getDb();
    await db
      .update(taskRuns)
      .set({ sessionObjectKey: null, sessionSizeBytes: null })
      .where(inArray(taskRuns.id, ids));
  }

  async clearExpiredSessions(
    now: Date,
    retentionDays: number,
    dbExecutor?: DbExecutor,
    orgId?: UuidV7,
  ): Promise<number> {
    const db = dbExecutor ?? getDb();
    const cutoff = new Date(
      now.getTime() - retentionDays * 24 * 60 * 60 * 1_000,
    );
    const cleared = await db
      .update(taskRuns)
      .set({ sessionObjectKey: null, sessionSizeBytes: null, updatedAt: now })
      .where(
        and(
          isNotNull(taskRuns.sessionObjectKey),
          lte(taskRuns.completedAt, cutoff),
          projectInOrg(taskRuns.projectId, orgId),
        ),
      )
      .returning({ id: taskRuns.id });

    return cleared.length;
  }

  async deleteMany(ids: UuidV7[], dbExecutor?: DbExecutor): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }

    const db = dbExecutor ?? getDb();
    const rows = await db
      .delete(taskRuns)
      .where(inArray(taskRuns.id, ids))
      .returning({ id: taskRuns.id });

    return rows.length;
  }

  async deleteByProjectId(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<number> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .delete(taskRuns)
      .where(eq(taskRuns.projectId, projectId))
      .returning({ id: taskRuns.id });

    return rows.length;
  }
}

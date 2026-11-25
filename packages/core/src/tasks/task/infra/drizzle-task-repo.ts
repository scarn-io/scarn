import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  notInArray,
  sql,
} from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { stepDefinitions, taskRuns, tasks } from "@scarn/core/lib/db/schema";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { PersistenceError } from "@scarn/core/lib/errors";
import {
  readRowsSkippingUnreadable,
  type StoredReadResult,
} from "@scarn/core/lib/db/stored-json";
import { noopLogger, type Logger } from "@scarn/observability/logging";
import {
  isScheduleConcurrencyGroup,
  type ConcurrencyGroupKey,
  type TaskRepo,
} from "../application/task-repo";
import { TaskEntity, type TaskStatus } from "../domain/task-entity";
import { toStoredTaskEnvironmentSelection } from "../contracts/task-environment-selection-contracts";
import {
  CURRENT_TASK_SCHEMA_VERSION,
  readStoredTask,
} from "../contracts/task-stored";
import { effectiveTaskStatusSql } from "./task-effective-status-sql";

type TaskRow = typeof tasks.$inferSelect;

const ENDED_STATUSES: readonly TaskStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
];

const optionalUuid = (value: string | null): UuidV7 | null =>
  value === null ? null : parseUuidV7(value);

const toRow = (task: TaskEntity) => {
  const { environmentSelection, ...props } = task.toJSON();
  return {
    ...props,
    environmentSelectionJson:
      toStoredTaskEnvironmentSelection(environmentSelection),
    schemaVersion: CURRENT_TASK_SCHEMA_VERSION,
  };
};

/**
 * Reads a `tasks` row through `readStoredTask`, or explains why it is
 * unreadable. Bulk reads skip an unreadable row (`readRowsSkippingUnreadable`);
 * single reads throw `TASK_ROW_UNREADABLE` (`taskRowToEntity`).
 */
export const readTaskRow = (row: TaskRow): StoredReadResult<TaskEntity> => {
  const read = readStoredTask(row.schemaVersion, row);
  if (!read.success) {
    return read;
  }
  const stored = read.value;
  return {
    success: true,
    value: TaskEntity.rehydrate({
      id: parseUuidV7(row.id),
      projectId: parseUuidV7(row.projectId),
      workItemId: optionalUuid(row.workItemId),
      stepDefinitionId: optionalUuid(row.stepDefinitionId),
      kind: row.kind,
      name: row.name,
      prompt: row.prompt,
      entrypointJson: stored.entrypointJson,
      toolCallJson: stored.toolCallJson,
      resultSchemaJson: stored.resultSchemaJson,
      taskExecutionConfigId: optionalUuid(row.taskExecutionConfigId),
      environmentSelection: stored.environmentSelection,
      inputJson: stored.inputJson,
      retryJson: stored.retryJson,
      grants: stored.grants,
      maxTurns: row.maxTurns,
      heartbeatSeconds: row.heartbeatSeconds,
      executionTimeoutSeconds: row.executionTimeoutSeconds,
      status: row.status,
      resultJson: stored.resultJson,
      errorJson: stored.errorJson,
      startedByUserId: optionalUuid(row.startedByUserId),
      startedByAutomationId: optionalUuid(row.startedByAutomationId),
      previousTaskId: optionalUuid(row.previousTaskId),
      conversationId: optionalUuid(row.conversationId),
      startedByScheduleId: optionalUuid(row.startedByScheduleId),
      scheduledFor: row.scheduledFor,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }),
  };
};

export const taskRowToEntity = (row: TaskRow): TaskEntity => {
  const read = readTaskRow(row);
  if (!read.success) {
    throw new PersistenceError(
      `Task ${row.id} is unreadable: ${read.reason}`,
      "TASK_ROW_UNREADABLE",
    );
  }
  return read.value;
};

/** The log fields that identify a skipped task row. */
export const describeTaskRow = (row: TaskRow) => ({
  table: "tasks",
  taskId: row.id,
  projectId: row.projectId,
});

export class DrizzleTaskRepo implements TaskRepo {
  constructor(private readonly logger: Logger = noopLogger) {}

  private toEntities(rows: readonly TaskRow[]): TaskEntity[] {
    return readRowsSkippingUnreadable(
      rows,
      readTaskRow,
      this.logger,
      describeTaskRow,
    );
  }

  async lock(id: UuidV7, dbExecutor: DbExecutor) {
    const [row] = await dbExecutor
      .select()
      .from(tasks)
      .where(eq(tasks.id, id))
      .limit(1)
      .for("update");
    return row ? taskRowToEntity(row) : null;
  }

  async load(id: UuidV7, dbExecutor?: DbExecutor) {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, id))
      .limit(1);
    return row ? taskRowToEntity(row) : null;
  }

  async loadLatestStatusByWorkItemIds(
    workItemIds: UuidV7[],
    dbExecutor?: DbExecutor,
  ) {
    const latest = new Map<UuidV7, TaskStatus>();
    if (workItemIds.length === 0) {
      return latest;
    }
    const db = dbExecutor ?? getDb();
    const rows = await db
      .selectDistinctOn([tasks.workItemId], {
        workItemId: tasks.workItemId,
        status: effectiveTaskStatusSql(),
      })
      .from(tasks)
      .where(inArray(tasks.workItemId, workItemIds))
      .orderBy(tasks.workItemId, desc(tasks.createdAt), desc(tasks.id));
    for (const row of rows) {
      latest.set(row.workItemId as UuidV7, row.status);
    }
    return latest;
  }

  async create(task: TaskEntity, dbExecutor?: DbExecutor) {
    const db = dbExecutor ?? getDb();
    const [row] = await db.insert(tasks).values(toRow(task)).returning();
    if (!row) {
      throw new PersistenceError(
        `Failed to create task ${task.id}`,
        "TASK_CREATE_FAILED",
      );
    }
    return taskRowToEntity(row);
  }

  async findLatestSucceededScheduledFor(
    scheduleId: UuidV7,
    dbExecutor?: DbExecutor,
  ) {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select({ scheduledFor: tasks.scheduledFor })
      .from(tasks)
      .where(
        and(
          eq(tasks.startedByScheduleId, scheduleId),
          eq(tasks.status, "succeeded"),
          isNotNull(tasks.scheduledFor),
        ),
      )
      .orderBy(desc(tasks.scheduledFor))
      .limit(1);
    return row?.scheduledFor ?? null;
  }

  async lockConcurrencyGroup(
    group: ConcurrencyGroupKey,
    dbExecutor: DbExecutor,
  ) {
    const key = isScheduleConcurrencyGroup(group)
      ? `task-concurrency-schedule:${group.projectId}:${group.scheduleId}`
      : `task-concurrency:${group.projectId}:${group.workItemId}:${group.stepKey}`;
    await dbExecutor.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
    );
  }

  async lockSpawnedWorkItems(taskId: UuidV7, dbExecutor: DbExecutor) {
    const key = `task-spawned-work-items:${taskId}`;
    await dbExecutor.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
    );
  }

  async listLiveInConcurrencyGroup(
    group: ConcurrencyGroupKey,
    dbExecutor: DbExecutor,
  ) {
    if (isScheduleConcurrencyGroup(group)) {
      const rows = await dbExecutor
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.projectId, group.projectId),
            eq(tasks.startedByScheduleId, group.scheduleId),
            notInArray(tasks.status, [...ENDED_STATUSES]),
          ),
        )
        .orderBy(asc(tasks.createdAt), asc(tasks.id));
      return this.toEntities(rows);
    }
    const rows = await dbExecutor
      .select({ task: tasks })
      .from(tasks)
      .innerJoin(
        stepDefinitions,
        eq(stepDefinitions.id, tasks.stepDefinitionId),
      )
      .where(
        and(
          eq(tasks.projectId, group.projectId),
          eq(tasks.workItemId, group.workItemId),
          eq(stepDefinitions.key, group.stepKey),
          notInArray(tasks.status, [...ENDED_STATUSES]),
        ),
      )
      .orderBy(asc(tasks.createdAt), asc(tasks.id));
    return this.toEntities(rows.map((row) => row.task));
  }

  async lockWaitingInConcurrencyGroup(
    group: ConcurrencyGroupKey,
    dbExecutor: DbExecutor,
  ) {
    const membership = isScheduleConcurrencyGroup(group)
      ? eq(tasks.startedByScheduleId, group.scheduleId)
      : and(
          eq(tasks.workItemId, group.workItemId),
          inArray(
            tasks.stepDefinitionId,
            dbExecutor
              .select({ id: stepDefinitions.id })
              .from(stepDefinitions)
              .where(
                and(
                  eq(stepDefinitions.projectId, group.projectId),
                  eq(stepDefinitions.key, group.stepKey),
                ),
              ),
          ),
        );
    const rows = await dbExecutor
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.projectId, group.projectId),
          membership,
          eq(tasks.status, "waiting_for_concurrency_slot"),
        ),
      )
      .orderBy(asc(tasks.createdAt), asc(tasks.id))
      .for("update", { skipLocked: true });
    return this.toEntities(rows);
  }

  async lockWaitingForWorkByWorkItemIds(
    workItemIds: UuidV7[],
    dbExecutor: DbExecutor,
  ) {
    if (workItemIds.length === 0) {
      return [];
    }
    const rows = await dbExecutor
      .select()
      .from(tasks)
      .where(
        and(
          inArray(tasks.workItemId, workItemIds),
          eq(tasks.status, "waiting_for_work"),
        ),
      )
      .orderBy(asc(tasks.createdAt), asc(tasks.id))
      .for("update");
    return this.toEntities(rows);
  }

  async lockByConversationId(conversationId: UuidV7, dbExecutor: DbExecutor) {
    const [row] = await dbExecutor
      .select()
      .from(tasks)
      .where(eq(tasks.conversationId, conversationId))
      .limit(1)
      .for("update");
    return row ? taskRowToEntity(row) : null;
  }

  async save(task: TaskEntity, dbExecutor?: DbExecutor) {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .update(tasks)
      .set({
        status: task.status,
        resultJson: task.resultJson,
        errorJson: task.errorJson,
        conversationId: task.conversationId,
        maxTurns: task.maxTurns,
        updatedAt: task.updatedAt,
      })
      .where(eq(tasks.id, task.id))
      .returning();
    if (!row) {
      throw new PersistenceError(
        `Failed to save task ${task.id}`,
        "TASK_SAVE_FAILED",
      );
    }
    return taskRowToEntity(row);
  }

  async deleteMany(ids: UuidV7[], dbExecutor?: DbExecutor) {
    if (ids.length === 0) {
      return 0;
    }
    const db = dbExecutor ?? getDb();
    return await db.transaction(async (tx) => {
      await tx.delete(taskRuns).where(inArray(taskRuns.taskId, ids));
      const rows = await tx
        .delete(tasks)
        .where(inArray(tasks.id, ids))
        .returning({ id: tasks.id });
      return rows.length;
    });
  }

  async deleteByProjectId(projectId: UuidV7, dbExecutor?: DbExecutor) {
    const db = dbExecutor ?? getDb();
    return await db.transaction(async (tx) => {
      await tx.delete(taskRuns).where(eq(taskRuns.projectId, projectId));
      const rows = await tx
        .delete(tasks)
        .where(eq(tasks.projectId, projectId))
        .returning({ id: tasks.id });
      return rows.length;
    });
  }
}

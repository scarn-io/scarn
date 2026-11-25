import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNull,
  lte,
  ne,
  sql,
} from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  automations,
  automationSchedules,
  tasks,
} from "@scarn/core/lib/db/schema";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { PersistenceError } from "@scarn/core/lib/errors";
import type { TaskStatus } from "@scarn/core/tasks/task/domain/task-entity";
import { effectiveTaskStatusSql } from "@scarn/core/tasks/task/infra/task-effective-status-sql";
import {
  type ScheduleConcurrency,
  scheduleConcurrencySchema,
} from "@scarn/sdk/contracts/automation-document";
import type {
  AutomationScheduleRepo,
  AutomationScheduleSummaryRecord,
} from "../application/automation-schedule-repo";
import { AutomationScheduleEntity } from "../domain/automation-schedule-entity";

type ScheduleRow = typeof automationSchedules.$inferSelect;

const rowToEntity = (row: ScheduleRow): AutomationScheduleEntity =>
  AutomationScheduleEntity.rehydrate({
    id: parseUuidV7(row.id),
    automationId: parseUuidV7(row.automationId),
    key: row.key,
    cron: row.cron,
    timezone: row.timezone,
    concurrency: { max: row.concurrencyMax, waiting: row.concurrencyWaiting },
    nextRunAt: row.nextRunAt,
    lastFiredAt: row.lastFiredAt,
    lastSkippedAt: row.lastSkippedAt,
    skippedCountSinceFire: row.skippedCountSinceFire,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt,
    removedAt: row.removedAt,
  });

/** The concurrency columns for a write, after the write schema's checks. */
const concurrencyColumns = (concurrency: ScheduleConcurrency) => {
  const { max, waiting } = scheduleConcurrencySchema.parse(concurrency);
  return { concurrencyMax: max, concurrencyWaiting: waiting };
};

const dueAt = (now: Date) =>
  and(
    eq(automations.enabled, true),
    isNull(automationSchedules.removedAt),
    lte(automationSchedules.nextRunAt, now),
  );

export class DrizzleAutomationScheduleRepo implements AutomationScheduleRepo {
  async load(
    id: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<AutomationScheduleEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(automationSchedules)
      .where(eq(automationSchedules.id, id))
      .limit(1);
    return row ? rowToEntity(row) : null;
  }

  async findLive(
    automationId: UuidV7,
    key: string,
    dbExecutor?: DbExecutor,
  ): Promise<AutomationScheduleEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(automationSchedules)
      .where(
        and(
          eq(automationSchedules.automationId, automationId),
          eq(automationSchedules.key, key),
          isNull(automationSchedules.removedAt),
        ),
      )
      .limit(1);
    return row ? rowToEntity(row) : null;
  }

  async listLiveByAutomationId(
    automationId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<AutomationScheduleEntity[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(automationSchedules)
      .where(
        and(
          eq(automationSchedules.automationId, automationId),
          isNull(automationSchedules.removedAt),
        ),
      )
      .orderBy(asc(automationSchedules.key));
    return rows.map(rowToEntity);
  }

  async listSummariesByAutomationIds(
    automationIds: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<AutomationScheduleSummaryRecord[]> {
    if (automationIds.length === 0) {
      return [];
    }
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(automationSchedules)
      .where(
        and(
          inArray(automationSchedules.automationId, [...automationIds]),
          isNull(automationSchedules.removedAt),
        ),
      )
      .orderBy(asc(automationSchedules.key), asc(automationSchedules.id));
    if (rows.length === 0) {
      return [];
    }
    const status = effectiveTaskStatusSql({
      id: sql`t.id`,
      status: sql`t.status`,
    });
    const stats = await db.execute<{
      schedule_id: string;
      last_task_id: string | null;
      last_task_status: TaskStatus | null;
      last_task_scheduled_for: string | null;
      failure_streak: number;
    }>(sql`
      select s.id as schedule_id, lt.id as last_task_id,
        lt.status as last_task_status,
        to_char(lt.scheduled_for at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as last_task_scheduled_for,
        fs.streak as failure_streak
      from ${automationSchedules} s
      left join lateral (
        select t.id, ${status} as status, t.scheduled_for
        from ${tasks} t
        where t.started_by_schedule_id = s.id
        order by t.scheduled_for desc, t.id desc
        limit 1
      ) lt on true
      cross join lateral (
        select count(*)::int as streak
        from ${tasks} t
        where t.started_by_schedule_id = s.id and ${status} = 'failed'
          and t.scheduled_for > coalesce((
            select max(u.scheduled_for) from ${tasks} u
            where u.started_by_schedule_id = s.id and u.status = 'succeeded'
          ), '-infinity'::timestamptz)
      ) fs
      where s.id in (${sql.join(
        rows.map((row) => sql`${row.id}::uuid`),
        sql`, `,
      )})
    `);
    const statsById = new Map(stats.rows.map((row) => [row.schedule_id, row]));
    return rows.map((row) => {
      const stat = statsById.get(row.id);
      return {
        schedule: rowToEntity(row),
        lastTask:
          stat?.last_task_id &&
          stat.last_task_status &&
          stat.last_task_scheduled_for
            ? {
                id: parseUuidV7(stat.last_task_id),
                status: stat.last_task_status,
                scheduledFor: new Date(stat.last_task_scheduled_for),
              }
            : null,
        failureStreak: stat?.failure_streak ?? 0,
      };
    });
  }

  async countLiveEnabledInProject(
    projectId: UuidV7,
    exceptAutomationId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<number> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select({ value: count() })
      .from(automationSchedules)
      .innerJoin(
        automations,
        eq(automations.id, automationSchedules.automationId),
      )
      .where(
        and(
          eq(automations.projectId, projectId),
          eq(automations.enabled, true),
          ne(automations.id, exceptAutomationId),
          isNull(automationSchedules.removedAt),
        ),
      );
    return row?.value ?? 0;
  }

  async insert(
    schedule: AutomationScheduleEntity,
    dbExecutor?: DbExecutor,
  ): Promise<AutomationScheduleEntity> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .insert(automationSchedules)
      .values({
        id: schedule.id,
        automationId: schedule.automationId,
        key: schedule.key,
        cron: schedule.cron,
        timezone: schedule.timezone,
        ...concurrencyColumns(schedule.concurrency),
        nextRunAt: schedule.nextRunAt,
        removedAt: schedule.removedAt,
      })
      .returning();
    if (!row) {
      throw new PersistenceError(
        `Automation schedule ${schedule.id} was not inserted`,
      );
    }
    return rowToEntity(row);
  }

  async update(
    schedule: AutomationScheduleEntity,
    dbExecutor?: DbExecutor,
  ): Promise<AutomationScheduleEntity> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .update(automationSchedules)
      .set({
        cron: schedule.cron,
        timezone: schedule.timezone,
        ...concurrencyColumns(schedule.concurrency),
        nextRunAt: schedule.nextRunAt,
        removedAt: schedule.removedAt,
        updatedAt: new Date(),
      })
      .where(eq(automationSchedules.id, schedule.id))
      .returning();
    if (!row) {
      throw new PersistenceError(
        `Automation schedule ${schedule.id} was not updated`,
      );
    }
    return rowToEntity(row);
  }

  async claimNextDue(
    now: Date,
    dbExecutor: DbExecutor,
  ): Promise<AutomationScheduleEntity | null> {
    const [row] = await dbExecutor
      .select({ schedule: automationSchedules })
      .from(automationSchedules)
      .innerJoin(
        automations,
        eq(automations.id, automationSchedules.automationId),
      )
      .where(dueAt(now))
      .orderBy(asc(automationSchedules.nextRunAt), asc(automationSchedules.id))
      .limit(1)
      .for("update", { of: automationSchedules, skipLocked: true });
    return row ? rowToEntity(row.schedule) : null;
  }

  async countDue(now: Date, dbExecutor?: DbExecutor): Promise<number> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select({ value: count() })
      .from(automationSchedules)
      .innerJoin(
        automations,
        eq(automations.id, automationSchedules.automationId),
      )
      .where(dueAt(now));
    return row?.value ?? 0;
  }

  async advanceNextRunAt(
    id: UuidV7,
    nextRunAt: Date,
    now: Date,
    dbExecutor?: DbExecutor,
  ) {
    await this.updateSummary(id, { nextRunAt, updatedAt: now }, dbExecutor);
  }

  async recordFired(id: UuidV7, now: Date, dbExecutor?: DbExecutor) {
    await this.updateSummary(
      id,
      { lastFiredAt: now, skippedCountSinceFire: 0, updatedAt: now },
      dbExecutor,
    );
  }

  async recordSkipped(id: UuidV7, now: Date, dbExecutor?: DbExecutor) {
    await this.updateSummary(
      id,
      {
        lastSkippedAt: now,
        skippedCountSinceFire: sql`${automationSchedules.skippedCountSinceFire} + 1`,
        updatedAt: now,
      },
      dbExecutor,
    );
  }

  async recordError(
    id: UuidV7,
    error: { message: string; at: Date; nextRunAt: Date },
    dbExecutor?: DbExecutor,
  ) {
    await this.updateSummary(
      id,
      {
        lastError: error.message,
        lastErrorAt: error.at,
        nextRunAt: error.nextRunAt,
        updatedAt: error.at,
      },
      dbExecutor,
    );
  }

  private async updateSummary(
    id: UuidV7,
    values: PgUpdateSetSource<typeof automationSchedules>,
    dbExecutor?: DbExecutor,
  ): Promise<void> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .update(automationSchedules)
      .set(values)
      .where(eq(automationSchedules.id, id))
      .returning({ id: automationSchedules.id });
    if (rows.length === 0) {
      throw new PersistenceError(`Automation schedule ${id} was not updated`);
    }
  }
}

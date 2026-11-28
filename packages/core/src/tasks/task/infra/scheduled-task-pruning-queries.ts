import { sql, type SQL } from "drizzle-orm";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  automationSchedules,
  nodeVisits,
  tasks,
} from "@scarn/core/lib/db/schema";
import type {
  PrunableScheduledTask,
  ScheduledTaskRetentionPolicy,
} from "@scarn/core/tasks/scheduled-task-retention/domain/scheduled-task-retention";

/**
 * The scheduled-Task retention rule (`scheduled-task-retention.ts`) in SQL,
 * for `DrizzleTaskRepo.listPrunableScheduled` and `lockPrunableScheduled`.
 */

/** The id of schedule `scheduleId`'s latest succeeded Task, as a subquery. */
const latestSucceededOf = (scheduleId: SQL) => sql`
  select u.id from ${tasks} u
  where u.started_by_schedule_id = ${scheduleId}
    and u.status = 'succeeded'
    and u.scheduled_for is not null
  order by u.scheduled_for desc, u.id desc
  limit 1
`;

/**
 * The parts of the rule that hold for a single ended Task `task`, whatever
 * its rank: not a failure inside the failure window, not its schedule's
 * latest succeeded Task (`latestSucceededId`), no conversation, and nothing
 * restrict-references it.
 *
 * The `offset 0` keeps each `not exists` a per-row index probe; without it
 * the planner may turn them into anti joins that scan all of `tasks` per
 * candidate.
 */
const stillPrunable = (
  task: SQL,
  latestSucceededId: SQL,
  policy: ScheduledTaskRetentionPolicy,
) => sql`
  ${task}.conversation_id is null
  and not (
    ${task}.status = 'failed'
    and ${task}.scheduled_for >= ${policy.keepFailedScheduledSince.toISOString()}::timestamptz
  )
  and ${task}.id is distinct from ${latestSucceededId}
  and not exists (
    select 1 from ${tasks} p where p.previous_task_id = ${task}.id offset 0
  )
  and not exists (
    select 1 from ${nodeVisits} v where v.task_id = ${task}.id offset 0
  )
`;

type PrunableRow = { id: string; project_id: string };

const toPrunable = (rows: PrunableRow[]): PrunableScheduledTask[] =>
  rows.map((row) => ({
    id: parseUuidV7(row.id),
    projectId: parseUuidV7(row.project_id),
  }));

/**
 * Up to `limit` Tasks the rule lets go, oldest `scheduled_for` first. Each
 * schedule's ended Tasks are read newest first through
 * `tasks_started_by_schedule_id_status_scheduled_for_idx`, skipping the
 * newest `keepNewest`.
 */
export const selectPrunableScheduled = async (
  policy: ScheduledTaskRetentionPolicy,
  limit: number,
  db: DbExecutor,
) => {
  const rows = await db.execute<PrunableRow>(sql`
    select c.id, c.project_id
    from ${automationSchedules} s
    left join lateral (${latestSucceededOf(sql`s.id`)}) ls on true
    cross join lateral (
      select t.id, t.project_id, t.status, t.scheduled_for, t.conversation_id
      from ${tasks} t
      where t.started_by_schedule_id = s.id
        and t.status in ('succeeded', 'failed', 'cancelled')
        and t.scheduled_for is not null
      order by t.scheduled_for desc, t.id desc
      offset ${policy.keepNewest}
    ) c
    where ${stillPrunable(sql`c`, sql`ls.id`, policy)}
    order by c.scheduled_for asc, c.id asc
    limit ${limit}
  `);
  return toPrunable(rows.rows);
};

/**
 * Locks those of `ids` the rule still lets go, skipping rows another
 * transaction holds. Re-checks every part of the rule except the rank, which
 * `selectPrunableScheduled` checked moments before.
 */
export const lockPrunableScheduled = async (
  ids: UuidV7[],
  policy: ScheduledTaskRetentionPolicy,
  tx: DbExecutor,
) => {
  if (ids.length === 0) {
    return [];
  }
  const rows = await tx.execute<PrunableRow>(sql`
    select t.id, t.project_id
    from ${tasks} t
    where t.id in (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
      and t.started_by_schedule_id is not null
      and t.status in ('succeeded', 'failed', 'cancelled')
      and t.scheduled_for is not null
      and ${stillPrunable(
        sql`t`,
        sql`(${latestSucceededOf(sql`t.started_by_schedule_id`)})`,
        policy,
      )}
    order by t.id
    for update of t skip locked
  `);
  return toPrunable(rows.rows);
};

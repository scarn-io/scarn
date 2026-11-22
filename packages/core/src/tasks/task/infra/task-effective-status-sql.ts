/**
 * The Task status every read should show. `tasks.status` only moves to
 * `failed` when a claim poll fails a run whose lease or deadline lapsed, so
 * with no worker polling, a dead run's Task would read `running` forever.
 * These expressions apply the run's liveness clocks on read (as
 * `TaskRunEntityBase.status` does), giving such a Task the `failed` status
 * `TaskEntity.followRun` will write once a worker polls. Reads never write.
 */
import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { taskRuns, tasks } from "@scarn/core/lib/db/schema";
import { namedRunError } from "../domain/run-error";
import type { TaskStatus } from "../domain/task-entity";

/** The Task columns the expressions read; a table alias passes its own. */
export type TaskStatusColumns = {
  id: AnyColumn | SQL;
  status: AnyColumn | SQL;
};

const TASKS_TABLE: TaskStatusColumns = { id: tasks.id, status: tasks.status };

const latestRun = (task: TaskStatusColumns) =>
  sql`(select lr.id from ${taskRuns} lr where lr.task_id = ${task.id} order by lr.number desc limit 1)`;

/**
 * The lapsed run's own status (`timeout` wins ties, as on the entity), or
 * null while the Task's latest run is live or ended.
 */
const lapsedRunStatus = (task: TaskStatusColumns) => sql<
  "timeout" | "abandoned" | null
>`(
  select case
    when r.execution_deadline_at is not null and r.execution_deadline_at <= now() then 'timeout'
    when r.lease_expires_at is not null and r.lease_expires_at <= now() then 'abandoned'
  end
  from ${taskRuns} r
  where r.id = ${latestRun(task)} and r.status = 'running'
)`;

/** `task`'s status with its latest run's liveness clocks applied. */
export const effectiveTaskStatusSql = (
  task: TaskStatusColumns = TASKS_TABLE,
): SQL<TaskStatus> =>
  sql<TaskStatus>`(case
    when ${task.status} = 'running' and ${lapsedRunStatus(task)} is not null then 'failed'
    else ${task.status}::text
  end)`;

/**
 * The error message a Task failed only by a lapsed run shows, as
 * `namedRunError` words it; null for any other Task.
 */
export const lapsedRunErrorMessageSql = (
  task: TaskStatusColumns = TASKS_TABLE,
): SQL<string | null> =>
  sql<string | null>`(case
    when ${task.status} <> 'running' then null
    else (case ${lapsedRunStatus(task)}
      when 'timeout' then ${namedRunError({ status: "timeout", errorJson: null }).message}
      when 'abandoned' then ${namedRunError({ status: "abandoned", errorJson: null }).message}
    end)
  end)`;

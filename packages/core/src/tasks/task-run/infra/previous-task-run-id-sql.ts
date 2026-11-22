import { sql, type SQL } from "drizzle-orm";
import { taskRuns, tasks } from "@scarn/core/lib/db/schema";

/**
 * The run before the `task_runs` row in scope: the same Task's run
 * `number - 1`, or for a Task's first run, the highest-numbered run of its
 * `tasks.previous_task_id` (a rerun). Null when there is none.
 */
export const previousTaskRunIdSql: SQL<string | null> = sql<string | null>`(
  case when ${taskRuns.number} = 1 then (
    select previous_run.id
    from ${taskRuns} as previous_run
    join ${tasks} as own_task
      on own_task.previous_task_id = previous_run.task_id
    where own_task.id = ${taskRuns.taskId}
    order by previous_run.number desc
    limit 1
  ) else (
    select previous_run.id
    from ${taskRuns} as previous_run
    where previous_run.task_id = ${taskRuns.taskId}
      and previous_run.number = ${taskRuns.number} - 1
  ) end
)`;

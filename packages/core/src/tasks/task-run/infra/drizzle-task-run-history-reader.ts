import { sql } from "drizzle-orm";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { isoUtcText } from "@scarn/core/lib/db/raw-sql";
import { taskMessages, taskRuns } from "@scarn/core/lib/db/schema";
import { TaskMessageEntity } from "@scarn/core/tasks/task-message/domain/task-message-entity";
import {
  TASK_RUN_HISTORY_MAX_ROWS,
  type TaskRunHistoryReader,
  type TaskRunHistoryEntry,
} from "../application/task-run-history-reader";
import type { TaskRunStatus } from "../domain/task-run-entity";
import { previousTaskRunIdSql } from "./previous-task-run-id-sql";

type RawTaskHistoryRow = {
  task_run_id: string;
  task_id: string;
  previous_task_run_id: string | null;
  status: TaskRunStatus;
  created_at: string;
  depth: number | string;
  message_id: string | null;
  message_author_user_id: string | null;
  message_body: string | null;
  message_quote_text: string | null;
  message_created_at: string | null;
};

/**
 * One recursive CTE walks each run's previous run (`previousTaskRunIdSql`:
 * the Task's run `number - 1`, else the previous Task's last run) back to the
 * first one, then joins each Task's messages onto that Task's first run. The
 * depth bound keeps the walk finite even if the data ever held a cycle. The
 * newest rows win the
 * `TASK_RUN_HISTORY_MAX_ROWS` cap; the result is returned oldest first.
 *
 * The `status` case mirrors `TaskRunEntityBase.status` (timeout wins ties), the
 * same transcription as `pipeline-run-status-subquery.ts`.
 */
export class DrizzleTaskRunHistoryReader implements TaskRunHistoryReader {
  async loadHistory(
    taskRunId: UuidV7,
    now: Date,
    dbExecutor?: DbExecutor,
  ): Promise<TaskRunHistoryEntry[]> {
    const db = dbExecutor ?? getDb();
    const boundNow = sql`${now.toISOString()}::timestamptz`;
    const rows = await db.execute<RawTaskHistoryRow>(sql`
      with recursive chain(task_run_id, depth) as (
        select ${taskRuns.id} as task_run_id, 0 as depth
        from ${taskRuns}
        where ${taskRuns.id} = ${taskRunId}
        union
        select ${previousTaskRunIdSql} as task_run_id, chain.depth + 1 as depth
        from ${taskRuns}
        join chain on chain.task_run_id = ${taskRuns.id}
        where ${previousTaskRunIdSql} is not null
          and chain.depth < ${TASK_RUN_HISTORY_MAX_ROWS}
      )
      select
        ${taskRuns.id} as task_run_id,
        ${taskRuns.taskId} as task_id,
        ${previousTaskRunIdSql} as previous_task_run_id,
        case
          when ${taskRuns.status} = 'running'
            and ${taskRuns.executionDeadlineAt} is not null
            and ${taskRuns.executionDeadlineAt} <= ${boundNow}
          then 'timeout'
          when ${taskRuns.status} = 'running'
            and ${taskRuns.leaseExpiresAt} is not null
            and ${taskRuns.leaseExpiresAt} <= ${boundNow}
          then 'abandoned'
          else ${taskRuns.status}::text
        end as status,
        ${isoUtcText(taskRuns.createdAt)} as created_at,
        chain.depth as depth,
        ${taskMessages.id} as message_id,
        ${taskMessages.authorUserId} as message_author_user_id,
        ${taskMessages.body} as message_body,
        ${taskMessages.quoteText} as message_quote_text,
        ${isoUtcText(taskMessages.createdAt)} as message_created_at
      from chain
      join ${taskRuns} on ${taskRuns.id} = chain.task_run_id
      left join ${taskMessages}
        on ${taskMessages.taskId} = ${taskRuns.taskId}
        and ${taskRuns.number} = 1
      order by
        chain.depth asc,
        ${taskMessages.createdAt} desc nulls last,
        ${taskMessages.id} desc nulls last
      limit ${TASK_RUN_HISTORY_MAX_ROWS}
    `);

    const runsById = new Map<string, TaskRunHistoryEntry>();
    for (const row of [...rows.rows].reverse()) {
      let run = runsById.get(row.task_run_id);
      if (!run) {
        run = {
          taskRunId: parseUuidV7(row.task_run_id),
          previousTaskRunId:
            row.previous_task_run_id === null
              ? null
              : parseUuidV7(row.previous_task_run_id),
          status: row.status,
          createdAt: new Date(row.created_at),
          messages: [],
        };
        runsById.set(row.task_run_id, run);
      }
      if (row.message_id !== null) {
        run.messages.push(
          TaskMessageEntity.rehydrate({
            id: parseUuidV7(row.message_id),
            taskId: parseUuidV7(row.task_id),
            authorUserId: parseUuidV7(row.message_author_user_id ?? ""),
            body: row.message_body ?? "",
            quoteText: row.message_quote_text,
            createdAt: row.message_created_at,
          }),
        );
      }
    }

    return [...runsById.values()];
  }
}

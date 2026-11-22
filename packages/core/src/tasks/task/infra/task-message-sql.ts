/** SQL for what a Task last said, shared by the Task and child work item reads. */
import { sql, type SQL } from "drizzle-orm";
import {
  conversationMessages,
  taskRuns,
  tasks,
} from "@scarn/core/lib/db/schema";
import { lapsedRunErrorMessageSql } from "./task-effective-status-sql";

const TEXT_LENGTH = 1000;

const errorText = (json: SQL) =>
  sql`case jsonb_typeof(${json}) when 'string' then ${json} #>> '{}' when 'object' then ${json} ->> 'message' end`;

/**
 * A failed Task's error message, else its latest run's; `null` unless `failed`
 * (`effectiveTaskStatusSql`, so a Task whose run lapsed reports why).
 */
export const taskErrorMessageSql = sql<
  string | null
>`case when ${tasks.status} = 'failed' then coalesce(
  ${errorText(sql`${tasks.errorJson}`)},
  (select ${errorText(sql`r.error_json`)} from ${taskRuns} r where r.task_id = ${tasks.id} order by r.number desc limit 1)
) else ${lapsedRunErrorMessageSql()} end`;

/** The newest agent message in the Task's conversation, cut short. */
export const taskLastAgentMessageSql = sql<string | null>`(
  select left(m.body, ${TEXT_LENGTH}) from ${conversationMessages} m
  where m.conversation_id = ${tasks.conversationId} and m.author_kind = 'agent'
  order by m.created_at desc, m.id desc limit 1
)`;

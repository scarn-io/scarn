/**
 * The Runs list as one SQL row set: every pipeline run and every Task not
 * owned by a node visit that has a work item or a conversation (single
 * steps, prompt Tasks and Tasks without a work item), with each row's
 * `ProjectRunStatus` derived in SQL by a `case` per kind that mirrors
 * `deriveProjectRunStatus`. Filters, counts and paging read over it.
 */
import { sql, type SQL } from "drizzle-orm";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  conversationMessages,
  conversations,
  nodeVisitQuestions,
  nodeVisits,
  pipelineGraphVersions,
  pipelineGraphs,
  pipelineRuns,
  stepDefinitions,
  taskRuns,
  tasks,
  workItemComments,
  workItems,
} from "@scarn/core/lib/db/schema";
import { effectiveTaskStatusSql } from "@scarn/core/tasks/task/infra/task-effective-status-sql";
import {
  taskWaitsOnUserSql,
  type TaskWaitingOnColumns,
} from "@scarn/core/tasks/task/infra/task-waiting-on-sql";
import { workItemWaitingOnPeopleSql } from "@scarn/core/work-items/work-item/infra/work-item-waiting-on-sql";
import { toContainsPattern } from "@scarn/core/work-items/work-item/infra/work-item-listing-query";
import type { ProjectRunsScope } from "../application/project-runs-reader";

/** The columns every row of `projectRunRowsSql` has. */
export type ProjectRunRowColumns = {
  type: "pipeline" | "step" | "task";
  id: string;
  updated_at: string;
  status: string;
  what_ran_key: string;
  what_ran_name: string;
  started_by_automation_id: string | null;
  started_by_user_id: string | null;
  work_item_id: string | null;
  run_waiter_user_ids: string[];
  at_node: boolean;
};

const viewerIs = (viewerUserId: UuidV7 | null, userIds: SQL): SQL =>
  viewerUserId === null
    ? sql`false`
    : sql`${viewerUserId}::uuid = any(${userIds})`;

const searchMatch = (q: string | undefined, text: SQL): SQL =>
  q === undefined ? sql`true` : sql`(${text}) ilike ${toContainsPattern(q)}`;

const definitionNode = sql`gv.definition_json -> 'nodes' -> wv.node_id`;

/** A waiting visit waits on a person: a step whose agent handed over, or a reply or decision wait. */
const runWaitsOnPerson = sql`exists (
  select 1 from ${nodeVisits} wv
  where wv.pipeline_run_id = r.id and wv.status = 'waiting'
    and (wv.node_kind = 'step' or (
      ${definitionNode} ->> 'kind' = 'wait'
      and ${definitionNode} ->> 'for' in ('reply', 'decision')
    ))
)`;

/** An open step visit whose Task's latest run is running, liveness clocks applied. */
const runHasRunningStep = sql`exists (
  select 1 from ${nodeVisits} sv
  join ${taskRuns} tr on tr.id = (
    select lr.id from ${taskRuns} lr where lr.task_id = sv.task_id
    order by lr.number desc limit 1
  )
  where sv.pipeline_run_id = r.id and sv.node_kind = 'step'
    and sv.status in ('active', 'waiting') and tr.status = 'running'
    and not coalesce(tr.execution_deadline_at <= now(), false)
    and not coalesce(tr.lease_expires_at <= now(), false)
)`;

/** `workItemWaitingOnUserIds`: the work item's (or nearest parent's) people, then the starter. */
const runWaiterUserIds = sql`array_remove(${workItemWaitingOnPeopleSql({
  assigneeUserId: sql`w.assignee_user_id`,
  createdByUserId: sql`w.created_by_user_id`,
  parentWorkItemId: sql`w.parent_work_item_id`,
})} || array[r.triggered_by_user_id]::uuid[], null)`;

const pipelineRows = (scope: ProjectRunsScope, atNode: string | undefined) => {
  const waiters = sql`(case when r.status = 'waiting' and ${runWaitsOnPerson} then ${runWaiterUserIds} else '{}'::uuid[] end)`;
  return sql`
  select 'pipeline'::text as type, r.id, r.updated_at,
    (case r.status
      when 'active' then (case when ${runHasRunningStep} then 'running' else 'queued' end)
      when 'waiting' then (case when ${viewerIs(scope.viewerUserId, waiters)} then 'needs-you' else 'waiting' end)
      when 'succeeded' then 'done'
      when 'failed' then (case when r.end_node_id is null then 'failed' else 'ended' end)
      else 'cancelled'
    end) as status,
    r.pipeline_graph_id::text as what_ran_key, g.name as what_ran_name,
    r.started_by_automation_id, r.triggered_by_user_id as started_by_user_id,
    r.work_item_id, ${waiters} as run_waiter_user_ids,
    ${
      atNode === undefined
        ? sql`true`
        : sql`exists (
          select 1 from ${nodeVisits} av where av.pipeline_run_id = r.id
            and av.node_id = ${atNode} and av.status in ('active', 'waiting')
        )`
    } as at_node
  from ${pipelineRuns} r
  join ${pipelineGraphs} g on g.id = r.pipeline_graph_id
  join ${pipelineGraphVersions} gv on gv.id = r.pipeline_graph_version_id
  join ${workItems} w on w.id = r.work_item_id
  where r.project_id = ${scope.projectId}
    and ${searchMatch(
      scope.q,
      sql`concat_ws(' ', w.title, w.platform_key, g.name,
        gv.definition_json -> 'nodes' -> r.end_node_id ->> 'error',
        r.error_json ->> 'message',
        (select string_agg(concat_ws(' ', sv.node_id, sv.error_json ->> 'message'), ' ')
          from ${nodeVisits} sv where sv.pipeline_run_id = r.id),
        (select string_agg(qc.body, ' ') from ${nodeVisitQuestions} oq
          join ${workItemComments} qc on qc.id = oq.comment_id
          where oq.pipeline_run_id = r.id and oq.status = 'open'))`,
    )}`;
};

/** Only a pipeline run can be at a node; with no node asked, every row is. */
const noAtNode = (atNode: string | undefined): SQL =>
  atNode === undefined ? sql`true` : sql`false`;

const taskStatusColumns = { id: sql`t.id`, status: sql`t.status` };

const effectiveStatus = effectiveTaskStatusSql(taskStatusColumns);

const taskWaitingOnColumns: TaskWaitingOnColumns = {
  taskStatus: effectiveStatus,
  taskStartedByUserId: sql`t.started_by_user_id`,
  workItemAssigneeUserId: sql`w.assignee_user_id`,
  workItemCreatedByUserId: sql`w.created_by_user_id`,
  workItemParentWorkItemId: sql`w.parent_work_item_id`,
};

const conversationMessage = (
  authorKind: "person" | "agent",
  order: "asc" | "desc",
) =>
  sql`(select m.body from ${conversationMessages} m
    where m.conversation_id = c.id and m.author_kind = ${authorKind}
    order by m.created_at ${sql.raw(order)}, m.id ${sql.raw(order)} limit 1)`;

/** A Task without a work item reads `done` once its conversation closes before the Task ends. */
const conversationClosed = sql`(t.work_item_id is null and c.status = 'closed'
  and ${effectiveStatus} not in ('succeeded', 'failed', 'cancelled'))`;

const standaloneTaskRows = (
  scope: ProjectRunsScope,
  atNode: string | undefined,
) => sql`
  select (case when t.step_definition_id is null then 'task' else 'step' end)::text as type,
    t.id,
    (case when t.work_item_id is null then greatest(t.updated_at, c.updated_at)
      else t.updated_at end) as updated_at,
    (case when ${conversationClosed} then 'done' else (case ${effectiveStatus}
      when 'waiting_for_person' then (case when ${
        scope.viewerUserId === null
          ? sql`false`
          : taskWaitsOnUserSql(taskWaitingOnColumns, scope.viewerUserId)
      } then 'needs-you' else 'waiting' end)
      when 'running' then 'running'
      when 'succeeded' then 'done'
      when 'failed' then 'failed'
      when 'cancelled' then 'cancelled'
      else 'queued'
    end) end) as status,
    coalesce(t.step_definition_id::text, 'task') as what_ran_key,
    coalesce(sd.name, 'Task') as what_ran_name,
    t.started_by_automation_id, t.started_by_user_id, t.work_item_id,
    '{}'::uuid[] as run_waiter_user_ids, ${noAtNode(atNode)} as at_node
  from ${tasks} t
  left join ${workItems} w on w.id = t.work_item_id
  left join ${conversations} c on c.id = t.conversation_id
  left join ${stepDefinitions} sd on sd.id = t.step_definition_id
  where t.project_id = ${scope.projectId}
    and (t.work_item_id is not null or (c.id is not null and c.work_item_id is null))
    and not exists (select 1 from ${nodeVisits} nv where nv.task_id = t.id)
    and ${searchMatch(
      scope.q,
      sql`(case when t.work_item_id is null
        then concat_ws(' ', ${conversationMessage("person", "asc")},
          ${conversationMessage("agent", "desc")}, sd.name, t.error_json ->> 'message')
        else concat_ws(' ', w.title, w.platform_key, t.prompt, sd.name,
          t.error_json ->> 'message') end)`,
    )}`;

/**
 * Every row of the project's Runs list in `scope` (search and work item
 * applied), as `ProjectRunRowColumns`. `at_node` is whether a pipeline run
 * has an open visit at `atNode`; true for every row when none is asked.
 */
export const projectRunRowsSql = (
  scope: ProjectRunsScope,
  atNode: string | undefined,
): SQL => {
  const rows = sql`
    ${pipelineRows(scope, atNode)}
    union all
    ${standaloneTaskRows(scope, atNode)}`;
  const inWorkItem =
    scope.workItemId === undefined
      ? sql`true`
      : sql`(x.work_item_id = ${scope.workItemId}::uuid or exists (
          select 1 from ${workItems} cw
          where cw.id = x.work_item_id and cw.parent_work_item_id = ${scope.workItemId}::uuid
        ))`;
  return sql`select x.* from (${rows}) x where ${inWorkItem}`;
};

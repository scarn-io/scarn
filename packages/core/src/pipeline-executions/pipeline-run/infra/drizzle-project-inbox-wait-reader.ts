import { sql } from "drizzle-orm";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  nodeVisitQuestions,
  nodeVisits,
  pipelineGraphVersions,
  pipelineGraphs,
  pipelineRuns,
  workItemComments,
  workItems,
} from "@scarn/core/lib/db/schema";
import type { DecisionBody } from "@scarn/sdk/contracts/pipeline-document";
import type {
  ProjectInboxWaitReader,
  ProjectInboxWaitRecord,
  ProjectInboxWorkItemRecord,
} from "../application/project-inbox-wait-reader";
import { readyWorkItemsOnUser } from "./project-inbox-work-items-sql";

type RawWaitRow = {
  kind: "reply" | "decision";
  pipeline_run_id: string;
  visit_id: string;
  node_id: string;
  pipeline_name: string;
  work_item_id: string;
  work_item_platform_key: string;
  work_item_title: string;
  work_item_created_by_user_id: string | null;
  run_triggered_by_user_id: string | null;
  asked_at: string;
  question_id: string | null;
  comment_id: string | null;
  body: string | null;
  title: string | null;
  actions: { key: string; label: string; body?: DecisionBody }[] | null;
};

type RawWorkItemRow = {
  id: string;
  platform_key: string;
  title: string;
  labels: string[];
  parent_id: string | null;
  parent_title: string | null;
  waiting_on_user_ids: string[];
  waiting_since: string;
};

const isoUtc = (column: string) =>
  sql.raw(
    `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
  );

/**
 * Open questions, and waiting decision visits on unfinished runs, in the
 * project that wait on `userId`, as one `union all`. A decision visit is told
 * apart from a reply wait by its node in the run's pinned document.
 */
const openWaitsOnUser = (projectId: UuidV7, userId: UuidV7) => sql`
  select 'reply' as kind, r.id as pipeline_run_id, q.visit_id, v.node_id,
    r.triggered_by_user_id as run_triggered_by_user_id, r.pipeline_graph_id,
    r.work_item_id, q.created_at as asked_ts, q.id as question_id,
    q.comment_id, c.body, null::text as title, null::jsonb as actions
  from ${nodeVisitQuestions} q
  join ${pipelineRuns} r on r.id = q.pipeline_run_id
  join ${nodeVisits} v on v.id = q.visit_id
  join ${workItemComments} c on c.id = q.comment_id
  join ${workItems} w on w.id = r.work_item_id
  where r.project_id = ${projectId} and q.status = 'open'
    and (w.created_by_user_id = ${userId} or r.triggered_by_user_id = ${userId})
  union all
  select 'decision' as kind, r.id, v.id, v.node_id, r.triggered_by_user_id,
    r.pipeline_graph_id, r.work_item_id, v.created_at, null::uuid, null::uuid,
    null::text, gv.definition_json -> 'nodes' -> v.node_id ->> 'title',
    gv.definition_json -> 'nodes' -> v.node_id -> 'actions'
  from ${nodeVisits} v
  join ${pipelineRuns} r on r.id = v.pipeline_run_id
  join ${pipelineGraphVersions} gv on gv.id = r.pipeline_graph_version_id
  join ${workItems} w on w.id = r.work_item_id
  where r.project_id = ${projectId} and r.status in ('active', 'waiting')
    and v.node_kind = 'wait' and v.status = 'waiting'
    and gv.definition_json -> 'nodes' -> v.node_id ->> 'for' = 'decision'
    and (w.created_by_user_id = ${userId} or r.triggered_by_user_id = ${userId})
`;

const optionalUuid = (value: string | null): UuidV7 | null =>
  value === null ? null : parseUuidV7(value);

const toRecord = (row: RawWaitRow): ProjectInboxWaitRecord => {
  const base = {
    pipelineRunId: parseUuidV7(row.pipeline_run_id),
    visitId: parseUuidV7(row.visit_id),
    nodeId: row.node_id,
    pipelineName: row.pipeline_name,
    workItem: {
      id: parseUuidV7(row.work_item_id),
      platformKey: row.work_item_platform_key,
      title: row.work_item_title,
    },
    waitingOnUserIds: [
      ...new Set(
        [
          optionalUuid(row.work_item_created_by_user_id),
          optionalUuid(row.run_triggered_by_user_id),
        ].filter((id): id is UuidV7 => id !== null),
      ),
    ],
    askedAt: row.asked_at,
  };
  return row.kind === "reply"
    ? {
        ...base,
        kind: "reply",
        questionId: parseUuidV7(row.question_id ?? ""),
        commentId: parseUuidV7(row.comment_id ?? ""),
        body: row.body ?? "",
      }
    : {
        ...base,
        kind: "decision",
        title: row.title,
        actions: (row.actions ?? []).map((action) => ({
          key: action.key,
          label: action.label,
          body: action.body ?? "optional",
        })),
      };
};

const toWorkItemRecord = (row: RawWorkItemRow): ProjectInboxWorkItemRecord => ({
  id: parseUuidV7(row.id),
  platformKey: row.platform_key,
  title: row.title,
  labels: row.labels,
  parent:
    row.parent_id === null || row.parent_title === null
      ? null
      : { id: parseUuidV7(row.parent_id), title: row.parent_title },
  waitingOnUserIds: [...new Set(row.waiting_on_user_ids.map(parseUuidV7))],
  waitingSince: row.waiting_since,
});

export class DrizzleProjectInboxWaitReader implements ProjectInboxWaitReader {
  async listOnUser(
    projectId: UuidV7,
    userId: UuidV7,
    limit: number,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectInboxWaitRecord[]> {
    const rows = await (dbExecutor ?? getDb()).execute<RawWaitRow>(sql`
      select x.kind, x.pipeline_run_id, x.visit_id, x.node_id,
        g.name as pipeline_name, w.id as work_item_id,
        w.platform_key as work_item_platform_key, w.title as work_item_title,
        w.created_by_user_id as work_item_created_by_user_id,
        x.run_triggered_by_user_id, ${isoUtc("x.asked_ts")} as asked_at,
        x.question_id, x.comment_id, x.body, x.title, x.actions
      from (${openWaitsOnUser(projectId, userId)}) x
      join ${workItems} w on w.id = x.work_item_id
      join ${pipelineGraphs} g on g.id = x.pipeline_graph_id
      order by x.asked_ts desc, x.visit_id desc
      limit ${limit}
    `);
    return rows.rows.map(toRecord);
  }

  async countOnUser(
    projectId: UuidV7,
    userId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<number> {
    const rows = await (dbExecutor ?? getDb()).execute<{ count: number }>(
      sql`select count(*)::int as count from (${openWaitsOnUser(projectId, userId)}) x`,
    );
    return rows.rows[0]?.count ?? 0;
  }

  async listWorkItemsOnUser(
    projectId: UuidV7,
    userId: UuidV7,
    limit: number,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectInboxWorkItemRecord[]> {
    const rows = await (dbExecutor ?? getDb()).execute<RawWorkItemRow>(sql`
      select x.id, x.platform_key, x.title, x.labels, p.id as parent_id,
        p.title as parent_title, x.waiting_on_user_ids,
        ${isoUtc("x.waiting_since")} as waiting_since
      from (${readyWorkItemsOnUser(projectId, userId)}) x
      left join ${workItems} p on p.id = x.parent_work_item_id
      order by x.waiting_since desc, x.id desc
      limit ${limit}
    `);
    return rows.rows.map(toWorkItemRecord);
  }

  async countWorkItemsOnUser(
    projectId: UuidV7,
    userId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<number> {
    const rows = await (dbExecutor ?? getDb()).execute<{ count: number }>(
      sql`select count(*)::int as count from (${readyWorkItemsOnUser(projectId, userId)}) x`,
    );
    return rows.rows[0]?.count ?? 0;
  }
}

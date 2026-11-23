import { sql, type SQL } from "drizzle-orm";
import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { ConversationStatus } from "@scarn/core/conversations/conversation/domain/conversation-entity";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  automations,
  conversationMessages,
  conversations,
  nodeVisitQuestions,
  taskRuns,
  tasks,
  workItemComments,
  workItems,
} from "@scarn/core/lib/db/schema";
import type { TaskRunStatus } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import type {
  ProjectRunCountGroup,
  ProjectRunKeyRecord,
  PipelineNodeLiveCountRecord,
  PipelineRunTotalsRecord,
  ProjectRunLatestTaskRun,
  ProjectRunsFacetFilter,
  ProjectRunsPageFilter,
  ProjectRunsReader,
  ProjectRunsScope,
  ProjectRunTaskConversation,
} from "../application/project-runs-reader";
import type {
  ProjectRunLookupKind,
  ProjectRunStatus,
  ProjectRunType,
} from "../contracts/project-runs-contracts";
import {
  pipelineNodeLiveCountsSql,
  pipelineTotalsSql,
  type RawNodeLiveCountRow,
  type RawPipelineTotalsRow,
} from "./pipeline-live-counts-sql";
import { projectRunRowsSql } from "./project-runs-sql";

const isoUtc = (column: string, fraction: "MS" | "US") =>
  sql.raw(
    `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.${fraction}"Z"')`,
  );

const uuidList = (ids: readonly string[]): SQL =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

const facetConditions = (
  scope: ProjectRunsScope,
  filter: ProjectRunsFacetFilter,
): SQL[] => [
  ...(filter.whatRan === undefined
    ? []
    : [sql`x.what_ran_key = ${filter.whatRan}`]),
  ...(filter.startedBy === undefined
    ? []
    : [
        filter.startedBy === "me"
          ? sql`x.started_by_user_id = ${scope.actorUserId}::uuid`
          : filter.startedBy === "scheduled"
            ? sql`x.started_by_schedule_id is not null`
            : sql`x.started_by_user_id is null and x.started_by_automation_id = ${filter.startedBy}::uuid`,
      ]),
  ...(filter.atNode === undefined ? [] : [sql`x.at_node`]),
];

type RawKeyRow = {
  type: ProjectRunType;
  id: string;
  status: ProjectRunStatus;
  updated_at_key: string;
  what_ran_name: string;
  run_waiter_user_ids: string[];
  work_item_id: string | null;
  work_item_platform_key: string | null;
  work_item_title: string | null;
  parent_id: string | null;
  parent_platform_key: string | null;
  parent_title: string | null;
};

const toKeyRecord = (row: RawKeyRow): ProjectRunKeyRecord => ({
  type: row.type,
  id: parseUuidV7(row.id),
  status: row.status,
  updatedAt: row.updated_at_key,
  whatRanName: row.what_ran_name,
  workItem:
    row.work_item_id === null ||
    row.work_item_platform_key === null ||
    row.work_item_title === null
      ? null
      : {
          id: parseUuidV7(row.work_item_id),
          platformKey: row.work_item_platform_key,
          title: row.work_item_title,
          parent:
            row.parent_id === null ||
            row.parent_platform_key === null ||
            row.parent_title === null
              ? null
              : {
                  id: parseUuidV7(row.parent_id),
                  platformKey: row.parent_platform_key,
                  title: row.parent_title,
                },
        },
  runWaiterUserIds: [...new Set(row.run_waiter_user_ids.map(parseUuidV7))],
});

type RawCountRow = {
  status: ProjectRunStatus;
  type: ProjectRunType;
  what_ran_key: string;
  what_ran_name: string;
  automation_id: string | null;
  automation_key: string | null;
  automation_title: string | null;
  by_actor: boolean;
  scheduled: boolean;
  at_node: boolean;
  count: number;
};

const toCountGroup = (row: RawCountRow): ProjectRunCountGroup => ({
  status: row.status,
  type: row.type,
  whatRanFilter: row.type === "task" ? row.type : parseUuidV7(row.what_ran_key),
  whatRanName: row.what_ran_name,
  startedByAutomation:
    row.automation_id === null || row.automation_key === null
      ? null
      : {
          id: parseUuidV7(row.automation_id),
          key: row.automation_key,
          title: row.automation_title,
        },
  startedByActor: row.by_actor,
  scheduled: row.scheduled,
  atNode: row.at_node,
  count: row.count,
});

const selectKeys = async (
  scope: ProjectRunsScope,
  atNode: string | undefined,
  tail: SQL,
  dbExecutor?: DbExecutor,
): Promise<ProjectRunKeyRecord[]> => {
  const rows = await (dbExecutor ?? getDb()).execute<RawKeyRow>(sql`
    select x.type, x.id, x.status, ${isoUtc("x.updated_at", "US")} as updated_at_key,
      x.what_ran_name, x.run_waiter_user_ids,
      w.id as work_item_id, w.platform_key as work_item_platform_key,
      w.title as work_item_title, p.id as parent_id,
      p.platform_key as parent_platform_key, p.title as parent_title
    from (${projectRunRowsSql(scope, atNode)}) x
    left join ${workItems} w on w.id = x.work_item_id
    left join ${workItems} p on p.id = w.parent_work_item_id
    ${tail}
  `);
  return rows.rows.map(toKeyRecord);
};

export class DrizzleProjectRunsReader implements ProjectRunsReader {
  async listPage(
    scope: ProjectRunsScope,
    filter: ProjectRunsPageFilter,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectRunKeyRecord[]> {
    if (filter.statuses.length === 0) {
      return [];
    }
    const conditions = [
      sql`x.status in (${sql.join(
        filter.statuses.map((status) => sql`${status}`),
        sql`, `,
      )})`,
      ...facetConditions(scope, filter),
      ...(filter.before === undefined
        ? []
        : [
            sql`(x.updated_at, x.id) < (${filter.before.updatedAt}::timestamptz, ${filter.before.id}::uuid)`,
          ]),
    ];
    return selectKeys(
      scope,
      filter.atNode,
      sql`where ${sql.join(conditions, sql` and `)}
        order by x.updated_at desc, x.id desc
        limit ${filter.limit}`,
      dbExecutor,
    );
  }

  async findKey(
    scope: ProjectRunsScope,
    kind: ProjectRunLookupKind,
    id: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectRunKeyRecord | null> {
    const types =
      kind === "task" ? sql`('step', 'task')` : sql`(${kind}::text)`;
    const [key] = await selectKeys(
      scope,
      undefined,
      sql`where x.id = ${id}::uuid and x.type in ${types} limit 1`,
      dbExecutor,
    );
    return key ?? null;
  }

  async countGroups(
    scope: ProjectRunsScope,
    atNode: string | undefined,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectRunCountGroup[]> {
    const rows = await (dbExecutor ?? getDb()).execute<RawCountRow>(sql`
      select x.status, x.type, x.what_ran_key, x.what_ran_name,
        a.id as automation_id, a.key as automation_key, a.title as automation_title,
        coalesce(x.started_by_user_id = ${scope.actorUserId}::uuid, false) as by_actor,
        x.started_by_schedule_id is not null as scheduled,
        x.at_node, count(*)::int as count
      from (${projectRunRowsSql(scope, atNode)}) x
      left join ${automations} a
        on a.id = x.started_by_automation_id and x.started_by_user_id is null
      group by x.status, x.type, x.what_ran_key, x.what_ran_name, a.id, a.key,
        a.title, by_actor, scheduled, x.at_node
    `);
    return rows.rows.map(toCountGroup);
  }

  async loadOpenQuestionBodies(
    pipelineRunIds: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<Map<UuidV7, string>> {
    if (pipelineRunIds.length === 0) {
      return new Map();
    }
    const rows = await (dbExecutor ?? getDb()).execute<{
      visit_id: string;
      body: string;
    }>(sql`
      select distinct on (q.visit_id) q.visit_id, c.body
      from ${nodeVisitQuestions} q
      join ${workItemComments} c on c.id = q.comment_id
      where q.pipeline_run_id in (${uuidList(pipelineRunIds)}) and q.status = 'open'
      order by q.visit_id, q.created_at desc, q.id desc
    `);
    return new Map(
      rows.rows.map((row) => [parseUuidV7(row.visit_id), row.body]),
    );
  }

  async loadLatestTaskRuns(
    taskIds: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<Map<UuidV7, ProjectRunLatestTaskRun>> {
    if (taskIds.length === 0) {
      return new Map();
    }
    const rows = await (dbExecutor ?? getDb()).execute<{
      task_id: string;
      status: TaskRunStatus;
      error_json: AnyJsonValue | null;
    }>(sql`
      select distinct on (r.task_id) r.task_id, (case
          when r.status = 'running' and r.execution_deadline_at <= now() then 'timeout'
          when r.status = 'running' and r.lease_expires_at <= now() then 'abandoned'
          else r.status::text
        end) as status, r.error_json
      from ${taskRuns} r
      where r.task_id in (${uuidList(taskIds)})
      order by r.task_id, r.number desc
    `);
    return new Map(
      rows.rows.map((row) => [
        parseUuidV7(row.task_id),
        { status: row.status, errorJson: row.error_json },
      ]),
    );
  }

  async loadTaskConversations(
    taskIds: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<Map<UuidV7, ProjectRunTaskConversation>> {
    if (taskIds.length === 0) {
      return new Map();
    }
    const rows = await (dbExecutor ?? getDb()).execute<{
      task_id: string;
      status: ConversationStatus;
      first_person_message: string | null;
      last_agent_message: string | null;
    }>(sql`
      select t.id as task_id, c.status,
        (select m.body from ${conversationMessages} m
          where m.conversation_id = c.id and m.author_kind = 'person'
          order by m.created_at asc, m.id asc limit 1) as first_person_message,
        (select m.body from ${conversationMessages} m
          where m.conversation_id = c.id and m.author_kind = 'agent'
          order by m.created_at desc, m.id desc limit 1) as last_agent_message
      from ${tasks} t
      join ${conversations} c on c.id = t.conversation_id
      where t.id in (${uuidList(taskIds)})
    `);
    return new Map(
      rows.rows.map((row) => [
        parseUuidV7(row.task_id),
        {
          status: row.status,
          firstPersonMessage: row.first_person_message,
          lastAgentMessage: row.last_agent_message,
        },
      ]),
    );
  }

  async pipelineLiveCounts(
    projectId: UuidV7,
    since: Date,
    dbExecutor?: DbExecutor,
  ): Promise<{
    pipelines: PipelineRunTotalsRecord[];
    nodes: PipelineNodeLiveCountRecord[];
  }> {
    const db = dbExecutor ?? getDb();
    const [totals, nodes] = await Promise.all([
      db.execute<RawPipelineTotalsRow>(pipelineTotalsSql(projectId, since)),
      db.execute<RawNodeLiveCountRow>(
        pipelineNodeLiveCountsSql(projectId, since),
      ),
    ]);
    return {
      pipelines: totals.rows.map((row) => ({
        pipelineDefinitionId: parseUuidV7(row.pipeline_definition_id),
        inProgress: row.in_progress,
        doneThisWeek: row.done_this_week,
      })),
      nodes: nodes.rows.map((row) => ({
        pipelineDefinitionId: parseUuidV7(row.pipeline_definition_id),
        nodeId: row.node_id,
        running: row.running,
        waiting: row.waiting,
        failed: row.failed,
        lanes: row.lanes,
      })),
    };
  }
}

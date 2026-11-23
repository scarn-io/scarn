import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNull,
  sql,
  type SQL,
} from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  automationSchedules,
  automations,
  conversationMessages,
  conversations,
  nodeVisits,
  pipelineGraphs,
  pipelineRuns,
  stepDefinitions,
  taskLogLines,
  taskRuns,
  tasks,
  workItems,
} from "@scarn/core/lib/db/schema";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { conversationPreview } from "@scarn/core/conversations/conversation/domain/repo-conversation-state";
import type { TaskStatus } from "../domain/task-entity";
import type {
  ProjectTaskSummaryFilter,
  ProjectTaskSummaryScope,
  TaskSummaryReader,
  TaskSummaryRecord,
} from "../application/task-summary-reader";
import {
  taskWaitingOnUserIdsSql,
  taskWaitsOnUserSql,
  type TaskWaitingOnColumns,
} from "./task-waiting-on-sql";
import {
  taskErrorMessageSql,
  taskLastAgentMessageSql,
} from "./task-message-sql";
import { effectiveTaskStatusSql } from "./task-effective-status-sql";

const TEXT_LENGTH = 1000;

const taskStatus = effectiveTaskStatusSql();

const waitingOnColumns: TaskWaitingOnColumns = {
  taskStatus,
  taskStartedByUserId: tasks.startedByUserId,
  workItemAssigneeUserId: workItems.assigneeUserId,
  workItemCreatedByUserId: workItems.createdByUserId,
  workItemParentWorkItemId: workItems.parentWorkItemId,
};
/** How far back from the newest log line to look for one worth showing. */
const LOG_SCAN_LINES = 200;

const optionalUuid = (value: string | null): UuidV7 | null =>
  value === null ? null : parseUuidV7(value);

const latestRunId = sql`(select r.id from ${taskRuns} r where r.task_id = ${tasks.id} order by r.number desc limit 1)`;

const durationMs = sql<number | null>`(
  select case when f.first_started_at is null then null else greatest(0, floor(extract(epoch from
    coalesce(r.completed_at, case when ${taskStatus} in ('waiting_for_work', 'queued', 'running') then now() else ${tasks.updatedAt} end)
    - f.first_started_at) * 1000))::float8 end
  from ${taskRuns} r,
    (select min(s.started_at) as first_started_at from ${taskRuns} s where s.task_id = ${tasks.id}) f
  where r.task_id = ${tasks.id}
  order by r.number desc limit 1
)`;

/**
 * The latest run's newest log line worth showing, mirroring the live feed's
 * display: worker and AI-server lines as written; on the `conversation`
 * stream, the agent's text, the tool it called, or a session error.
 */
const lastLogText = sql<string | null>`(
  select right(x.display, ${TEXT_LENGTH}) from (
    select l.seq, case
      when l.stream <> 'conversation' then l.content
      when pg_input_is_valid(l.content, 'jsonb') then (
        select case e.event ->> 'kind'
          when 'text' then case when e.event ->> 'role' = 'assistant' then e.event ->> 'text' end
          when 'tool' then '▸ ' || coalesce(e.event ->> 'title', e.event ->> 'tool')
          when 'session-error' then e.event ->> 'message'
        end from (select l.content::jsonb as event) e
      )
    end as display
    from ${taskLogLines} l
    where l.task_run_id = ${latestRunId}
    order by l.seq desc limit ${LOG_SCAN_LINES}
  ) x
  where x.display ~ '\\S'
  order by x.seq desc limit 1
)`;

const runNumber = sql<
  number | null
>`(select max(r.number) from ${taskRuns} r where r.task_id = ${tasks.id})`;

const pipelineRunNumber = sql<number | null>`(
  select count(*)::int from ${pipelineRuns} p
  where p.work_item_id = ${pipelineRuns.workItemId}
    and (p.created_at, p.id) <= (${pipelineRuns.createdAt}, ${pipelineRuns.id})
)`;

/** The Task's repo conversation (chat): a conversation of a Task without a work item. */
const repoConversationJoin = and(
  eq(conversations.id, tasks.conversationId),
  isNull(tasks.workItemId),
  isNull(conversations.workItemId),
);

const repoConversationQuestion = sql<string | null>`(
  select left(m.body, ${TEXT_LENGTH}) from ${conversationMessages} m
  where m.conversation_id = ${conversations.id} and m.author_kind = 'person'
  order by m.created_at asc, m.id asc limit 1
)`;

const notEndedChat = sql`${conversations.status} is distinct from 'closed'`;

const selectSummaries = (db: DbExecutor) =>
  db
    .select({
      id: tasks.id,
      projectId: tasks.projectId,
      kind: tasks.kind,
      name: tasks.name,
      status: taskStatus,
      prompt: tasks.prompt,
      startedByUserId: tasks.startedByUserId,
      startedByAutomationId: automations.id,
      startedByAutomationKey: automations.key,
      startedByAutomationTitle: automations.title,
      startedByScheduleId: automationSchedules.id,
      startedByScheduleKey: automationSchedules.key,
      startedByScheduleRemovedAt: automationSchedules.removedAt,
      scheduledFor: tasks.scheduledFor,
      conversationId: tasks.conversationId,
      waitingOnUserIds: taskWaitingOnUserIdsSql(waitingOnColumns),
      createdAt: tasks.createdAt,
      updatedAt: tasks.updatedAt,
      workItemId: workItems.id,
      workItemPlatformKey: workItems.platformKey,
      workItemTitle: workItems.title,
      repoConversationId: conversations.id,
      repoConversationQuestion,
      stepDefinitionId: stepDefinitions.id,
      stepDefinitionKey: stepDefinitions.key,
      stepDefinitionName: stepDefinitions.name,
      stepDefinitionVersion: stepDefinitions.version,
      pipelineRunId: nodeVisits.pipelineRunId,
      nodeId: nodeVisits.nodeId,
      pipelineName: pipelineGraphs.name,
      pipelineRunNumber,
      runNumber,
      durationMs,
      errorMessage: taskErrorMessageSql,
      lastAgentMessage: taskLastAgentMessageSql,
      lastLogText,
    })
    .from(tasks)
    .leftJoin(workItems, eq(workItems.id, tasks.workItemId))
    .leftJoin(conversations, repoConversationJoin)
    .leftJoin(stepDefinitions, eq(stepDefinitions.id, tasks.stepDefinitionId))
    .leftJoin(automations, eq(automations.id, tasks.startedByAutomationId))
    .leftJoin(
      automationSchedules,
      eq(automationSchedules.id, tasks.startedByScheduleId),
    )
    .leftJoin(nodeVisits, eq(nodeVisits.taskId, tasks.id))
    .leftJoin(pipelineRuns, eq(pipelineRuns.id, nodeVisits.pipelineRunId))
    .leftJoin(
      pipelineGraphs,
      eq(pipelineGraphs.id, pipelineRuns.pipelineGraphId),
    );

type SummaryRow = Awaited<ReturnType<typeof selectSummaries>>[number];

const toRecord = (row: SummaryRow): TaskSummaryRecord => ({
  id: parseUuidV7(row.id),
  projectId: parseUuidV7(row.projectId),
  kind: row.kind,
  name: row.name,
  status: row.status,
  prompt: row.prompt,
  startedByUserId: optionalUuid(row.startedByUserId),
  startedByAutomation:
    row.startedByAutomationId === null || row.startedByAutomationKey === null
      ? null
      : {
          id: parseUuidV7(row.startedByAutomationId),
          key: row.startedByAutomationKey,
          title: row.startedByAutomationTitle,
        },
  startedBySchedule:
    row.startedByScheduleId === null || row.startedByScheduleKey === null
      ? null
      : {
          id: parseUuidV7(row.startedByScheduleId),
          key: row.startedByScheduleKey,
          removed: row.startedByScheduleRemovedAt !== null,
        },
  scheduledFor: row.scheduledFor,
  conversationId: optionalUuid(row.conversationId),
  waitingOnUserIds: [...new Set(row.waitingOnUserIds.map(parseUuidV7))],
  workItem:
    row.workItemId === null ||
    row.workItemPlatformKey === null ||
    row.workItemTitle === null
      ? null
      : {
          id: parseUuidV7(row.workItemId),
          platformKey: row.workItemPlatformKey,
          title: row.workItemTitle,
        },
  repoConversation:
    row.repoConversationId === null
      ? null
      : {
          id: parseUuidV7(row.repoConversationId),
          title: conversationPreview(row.repoConversationQuestion),
        },
  stepDefinition:
    row.stepDefinitionId === null ||
    row.stepDefinitionKey === null ||
    row.stepDefinitionName === null ||
    row.stepDefinitionVersion === null
      ? null
      : {
          id: parseUuidV7(row.stepDefinitionId),
          key: row.stepDefinitionKey,
          name: row.stepDefinitionName,
          version: row.stepDefinitionVersion,
        },
  pipelineRunId: optionalUuid(row.pipelineRunId),
  nodeId: row.nodeId,
  pipelineRun:
    row.pipelineName === null || row.pipelineRunNumber === null
      ? null
      : { name: row.pipelineName, number: row.pipelineRunNumber },
  runNumber: row.runNumber,
  durationMs: row.durationMs === null ? null : Math.round(row.durationMs),
  errorMessage: row.errorMessage,
  lastAgentMessage: row.lastAgentMessage,
  lastLogText: row.lastLogText,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const beforeCursor = (beforeTaskId: UuidV7): SQL =>
  sql`(${tasks.createdAt}, ${tasks.id}) < (select c.created_at, c.id from ${tasks} c where c.id = ${beforeTaskId})`;

const newestOnWorkItem = sql`(${tasks.workItemId} is null or ${tasks.id} = (select n.id from ${tasks} n where n.work_item_id = ${tasks.workItemId} order by n.created_at desc, n.id desc limit 1))`;

const scopeConditions = (
  projectId: UuidV7,
  scope: ProjectTaskSummaryScope,
): (SQL | undefined)[] => [
  eq(tasks.projectId, projectId),
  scope.kind ? eq(tasks.kind, scope.kind) : undefined,
  scope.waitingOnUserId
    ? taskWaitsOnUserSql(waitingOnColumns, scope.waitingOnUserId)
    : undefined,
  scope.startedByUserId
    ? eq(tasks.startedByUserId, scope.startedByUserId)
    : undefined,
  scope.workItemIds
    ? inArray(tasks.workItemId, [...scope.workItemIds])
    : undefined,
  scope.latestPerWorkItem ? newestOnWorkItem : undefined,
  scope.excludeEndedChats ? notEndedChat : undefined,
];

export class DrizzleTaskSummaryReader implements TaskSummaryReader {
  async listByProject(
    projectId: UuidV7,
    filter: ProjectTaskSummaryFilter,
    dbExecutor?: DbExecutor,
  ) {
    const rows = await selectSummaries(dbExecutor ?? getDb())
      .where(
        and(
          ...scopeConditions(projectId, filter),
          filter.statuses
            ? inArray(taskStatus, [...filter.statuses])
            : undefined,
          filter.beforeTaskId ? beforeCursor(filter.beforeTaskId) : undefined,
        ),
      )
      .orderBy(desc(tasks.createdAt), desc(tasks.id))
      .limit(filter.limit);
    return rows.map(toRecord);
  }

  async countByStatus(
    projectId: UuidV7,
    scope: ProjectTaskSummaryScope,
    dbExecutor?: DbExecutor,
  ) {
    const rows = await (dbExecutor ?? getDb())
      .select({ status: taskStatus, count: count() })
      .from(tasks)
      .leftJoin(workItems, eq(workItems.id, tasks.workItemId))
      .leftJoin(conversations, repoConversationJoin)
      .where(and(...scopeConditions(projectId, scope)))
      .groupBy(taskStatus);
    return new Map<TaskStatus, number>(
      rows.map((row) => [row.status, row.count]),
    );
  }

  async loadByTaskId(taskId: UuidV7, dbExecutor?: DbExecutor) {
    const [row] = await selectSummaries(dbExecutor ?? getDb())
      .where(eq(tasks.id, taskId))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async loadByTaskIds(taskIds: readonly UuidV7[], dbExecutor?: DbExecutor) {
    if (taskIds.length === 0) {
      return [];
    }
    const rows = await selectSummaries(dbExecutor ?? getDb()).where(
      inArray(tasks.id, [...taskIds]),
    );
    return rows.map(toRecord);
  }

  async countInbox(projectId: UuidV7, userId: UuidV7, dbExecutor?: DbExecutor) {
    const waitingOnUser = taskWaitsOnUserSql(waitingOnColumns, userId);
    const [row] = await (dbExecutor ?? getDb())
      .select({
        agentWaitingOnUser: sql<number>`count(*) filter (where ${tasks.status} = 'waiting_for_person' and ${tasks.kind} = 'agent' and ${waitingOnUser})::int`,
        failedStartedByUser: sql<number>`count(*) filter (where ${taskStatus} = 'failed' and ${tasks.startedByUserId} = ${userId})::int`,
        waitingOnOthers: sql<number>`count(*) filter (where ${tasks.status} = 'waiting_for_person' and not ${waitingOnUser})::int`,
      })
      .from(tasks)
      .leftJoin(workItems, eq(workItems.id, tasks.workItemId))
      .leftJoin(conversations, repoConversationJoin)
      .where(
        and(
          eq(tasks.projectId, projectId),
          notEndedChat,
          inArray(tasks.status, ["waiting_for_person", "failed", "running"]),
        ),
      );
    return {
      agentWaitingOnUser: row?.agentWaitingOnUser ?? 0,
      failedStartedByUser: row?.failedStartedByUser ?? 0,
      waitingOnOthers: row?.waitingOnOthers ?? 0,
    };
  }
}

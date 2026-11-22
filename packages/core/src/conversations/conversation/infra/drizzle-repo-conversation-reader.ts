import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
  type SQL,
} from "drizzle-orm";
import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  conversationMessages,
  conversations,
  taskRuns,
  tasks,
} from "@scarn/core/lib/db/schema";
import type { TaskRunStatus } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import { effectiveTaskStatusSql } from "@scarn/core/tasks/task/infra/task-effective-status-sql";
import type {
  RepoConversationPin,
  RepoConversationReader,
  RepoConversationRecord,
} from "../application/repo-conversation-reader";

const taskStatus = effectiveTaskStatusSql();

const firstMessageBody = sql<string | null>`(
  select m.body from ${conversationMessages} m
  where m.conversation_id = ${conversations.id} and m.author_kind = 'person'
  order by m.created_at asc, m.id asc limit 1
)`;

const lastActivityAt = sql<Date>`greatest(
  ${conversations.createdAt},
  (select max(m.created_at) from ${conversationMessages} m where m.conversation_id = ${conversations.id}),
  (select max(coalesce(r.completed_at, r.started_at, r.created_at)) from ${taskRuns} r where r.task_id = ${tasks.id})
)`.mapWith((value: string | Date) => new Date(value));

const latestRunId = sql<
  string | null
>`(select r.id from ${taskRuns} r where r.task_id = ${tasks.id} order by r.number desc limit 1)`;

/** A run's status with its liveness clocks applied, as `TaskRunEntityBase.status`. */
const effectiveRunStatus = sql<TaskRunStatus>`(case
  when ${taskRuns.status} = 'running' and ${taskRuns.executionDeadlineAt} is not null and ${taskRuns.executionDeadlineAt} <= now() then 'timeout'
  when ${taskRuns.status} = 'running' and ${taskRuns.leaseExpiresAt} is not null and ${taskRuns.leaseExpiresAt} <= now() then 'abandoned'
  else ${taskRuns.status}::text
end)`;

const selectChats = (db: DbExecutor) =>
  db
    .select({
      conversationId: conversations.id,
      projectId: conversations.projectId,
      conversationStatus: conversations.status,
      taskId: tasks.id,
      taskStatus,
      startedByUserId: tasks.startedByUserId,
      firstMessageBody,
      latestRunId,
      createdAt: conversations.createdAt,
      lastActivityAt,
    })
    .from(conversations)
    .innerJoin(tasks, eq(tasks.conversationId, conversations.id));

type ChatRow = Awaited<ReturnType<typeof selectChats>>[number];

const isChat = and(isNull(tasks.workItemId), isNull(conversations.workItemId));

const beforeCursor = (beforeConversationId: UuidV7): SQL =>
  sql`(${conversations.createdAt}, ${conversations.id}) < (select c.created_at, c.id from ${conversations} c where c.id = ${beforeConversationId})`;

const loadRuns = async (rows: ChatRow[], db: DbExecutor) => {
  const runIds = rows.flatMap((row) =>
    row.latestRunId ? [row.latestRunId] : [],
  );
  const taskIds = rows.map((row) => row.taskId);
  const [latest, pins] = await Promise.all([
    runIds.length === 0
      ? []
      : db
          .select({
            id: taskRuns.id,
            status: effectiveRunStatus,
            reason: taskRuns.reason,
            errorJson: taskRuns.errorJson,
          })
          .from(taskRuns)
          .where(inArray(taskRuns.id, runIds)),
    taskIds.length === 0
      ? []
      : db
          .selectDistinctOn([taskRuns.taskId], {
            taskId: taskRuns.taskId,
            branch: taskRuns.baseBranch,
            commit: taskRuns.baseCommit,
            startedAt: taskRuns.startedAt,
            claimedAt: taskRuns.claimedAt,
            createdAt: taskRuns.createdAt,
          })
          .from(taskRuns)
          .where(
            and(
              inArray(taskRuns.taskId, taskIds),
              isNotNull(taskRuns.baseCommit),
            ),
          )
          .orderBy(taskRuns.taskId, asc(taskRuns.number)),
  ]);
  return {
    latestById: new Map(latest.map((run) => [run.id, run])),
    pinByTaskId: new Map<string, RepoConversationPin>(
      pins.flatMap((pin) =>
        pin.commit === null
          ? []
          : [
              [
                pin.taskId,
                {
                  branch: pin.branch,
                  commit: pin.commit,
                  pinnedAt: pin.startedAt ?? pin.claimedAt ?? pin.createdAt,
                },
              ],
            ],
      ),
    ),
  };
};

const toRecords = async (
  rows: ChatRow[],
  db: DbExecutor,
): Promise<RepoConversationRecord[]> => {
  const { latestById, pinByTaskId } = await loadRuns(rows, db);
  return rows.map((row) => {
    const latest = row.latestRunId ? latestById.get(row.latestRunId) : null;
    return {
      conversationId: parseUuidV7(row.conversationId),
      projectId: parseUuidV7(row.projectId),
      conversationStatus: row.conversationStatus,
      taskId: parseUuidV7(row.taskId),
      taskStatus: row.taskStatus,
      startedByUserId:
        row.startedByUserId === null ? null : parseUuidV7(row.startedByUserId),
      firstMessageBody: row.firstMessageBody,
      latestRun: latest
        ? {
            id: parseUuidV7(latest.id),
            status: latest.status,
            reason: latest.reason,
            errorJson: latest.errorJson as AnyJsonValue | null,
          }
        : null,
      pin: pinByTaskId.get(row.taskId) ?? null,
      createdAt: row.createdAt,
      lastActivityAt: row.lastActivityAt,
    };
  });
};

export class DrizzleRepoConversationReader implements RepoConversationReader {
  async listByProject(
    projectId: UuidV7,
    filter: { beforeConversationId?: UuidV7 | undefined; limit: number },
    dbExecutor?: DbExecutor,
  ) {
    const db = dbExecutor ?? getDb();
    const rows = await selectChats(db)
      .where(
        and(
          eq(conversations.projectId, projectId),
          isChat,
          filter.beforeConversationId
            ? beforeCursor(filter.beforeConversationId)
            : undefined,
        ),
      )
      .orderBy(desc(conversations.createdAt), desc(conversations.id))
      .limit(filter.limit);
    return await toRecords(rows, db);
  }

  async loadByConversationId(conversationId: UuidV7, dbExecutor?: DbExecutor) {
    const db = dbExecutor ?? getDb();
    const rows = await selectChats(db)
      .where(and(eq(conversations.id, conversationId), isChat))
      .limit(1);
    const [record] = await toRecords(rows, db);
    return record ?? null;
  }
}

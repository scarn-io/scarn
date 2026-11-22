import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  stepDefinitions,
  taskRuns,
  tasks,
  workItemBlocks,
  workItems,
} from "@scarn/core/lib/db/schema";
import {
  taskErrorMessageSql,
  taskLastAgentMessageSql,
} from "@scarn/core/tasks/task/infra/task-message-sql";
import { effectiveTaskStatusSql } from "@scarn/core/tasks/task/infra/task-effective-status-sql";
import type {
  ChildWorkItemLatestTaskRecord,
  ChildWorkItemReader,
} from "../application/child-work-item-reader";
import { parseWorkItemId, type WorkItemId } from "../domain/work-item-id";

const firstRunStartedAt = sql<
  string | null
>`(select min(r.started_at) from ${taskRuns} r where r.task_id = ${tasks.id})`;

const blockers = alias(workItems, "blockers");

export class DrizzleChildWorkItemReader implements ChildWorkItemReader {
  async loadLatestTasks(
    workItemIds: readonly WorkItemId[],
    dbExecutor?: DbExecutor,
  ) {
    const latest = new Map<WorkItemId, ChildWorkItemLatestTaskRecord>();
    if (workItemIds.length === 0) {
      return latest;
    }
    const rows = await (dbExecutor ?? getDb())
      .selectDistinctOn([tasks.workItemId], {
        workItemId: tasks.workItemId,
        id: tasks.id,
        status: effectiveTaskStatusSql(),
        stepKey: stepDefinitions.key,
        stepName: stepDefinitions.name,
        startedAt: firstRunStartedAt,
        updatedAt: tasks.updatedAt,
        lastAgentMessage: taskLastAgentMessageSql,
        errorMessage: taskErrorMessageSql,
      })
      .from(tasks)
      .leftJoin(stepDefinitions, eq(stepDefinitions.id, tasks.stepDefinitionId))
      .where(inArray(tasks.workItemId, [...workItemIds]))
      .orderBy(tasks.workItemId, desc(tasks.createdAt), desc(tasks.id));
    for (const row of rows) {
      if (row.workItemId === null) {
        continue;
      }
      latest.set(parseWorkItemId(row.workItemId), {
        id: parseUuidV7(row.id),
        status: row.status,
        step:
          row.stepKey === null || row.stepName === null
            ? null
            : { key: row.stepKey, name: row.stepName },
        startedAt: row.startedAt === null ? null : new Date(row.startedAt),
        updatedAt: row.updatedAt,
        lastAgentMessage: row.lastAgentMessage,
        errorMessage: row.errorMessage,
      });
    }
    return latest;
  }

  async loadOpenBlockers(
    workItemIds: readonly WorkItemId[],
    dbExecutor?: DbExecutor,
  ) {
    const byBlocked = new Map<
      WorkItemId,
      { id: WorkItemId; title: string }[]
    >();
    if (workItemIds.length === 0) {
      return byBlocked;
    }
    const rows = await (dbExecutor ?? getDb())
      .select({
        blockedId: workItemBlocks.blockedWorkItemId,
        id: blockers.id,
        title: blockers.title,
      })
      .from(workItemBlocks)
      .innerJoin(blockers, eq(blockers.id, workItemBlocks.blockingWorkItemId))
      .where(
        and(
          inArray(workItemBlocks.blockedWorkItemId, [...workItemIds]),
          eq(blockers.state, "open"),
        ),
      )
      .orderBy(asc(workItemBlocks.createdAt), asc(workItemBlocks.id));
    for (const row of rows) {
      const blockedId = parseWorkItemId(row.blockedId);
      const list = byBlocked.get(blockedId) ?? [];
      list.push({ id: parseWorkItemId(row.id), title: row.title });
      byBlocked.set(blockedId, list);
    }
    return byBlocked;
  }
}

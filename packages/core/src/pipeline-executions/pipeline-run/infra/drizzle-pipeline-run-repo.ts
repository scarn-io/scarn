import { and, asc, desc, eq, inArray, type SQL } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  laneGroups,
  lanes,
  nodeVisits,
  pipelineRuns,
  taskRuns,
  tasks,
} from "@scarn/core/lib/db/schema";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { PersistenceError } from "@scarn/core/lib/errors";
import type { WorkItemId } from "@scarn/core/work-items/work-item/domain/work-item-id";
import type {
  Lane,
  LaneGroup,
  LaneGroupPatch,
  LanePatch,
} from "../domain/engine/types";
import type {
  PipelineRunHistory,
  PipelineRunRepo,
} from "../application/pipeline-run-repo";
import {
  findRunStarterByTaskId,
  findVisitByConversationId,
} from "./pipeline-run-task-lookups";
import type { PipelineRunEntity } from "../domain/pipeline-run-entity";
import type { NodeVisitEntity } from "../domain/node-visit-entity";
import {
  laneEngineToRow,
  laneGroupRowToEngine,
  lanePatchToUpdate,
  laneRowToEngine,
  resultTaskIdOf,
  runEntityToRow,
  runEntityToUpdate,
  runRowToEntity,
  visitEntityToRow,
  visitEntityToUpdate,
  visitRowToEntity,
} from "./pipeline-run-row-mappers";

const emptyHistory = (): PipelineRunHistory => ({
  visits: [],
  laneGroups: [],
  lanes: [],
  visitTasks: [],
});

export class DrizzlePipelineRunRepo implements PipelineRunRepo {
  async load(
    id: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<PipelineRunEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, id))
      .limit(1);
    return row ? runRowToEntity(row) : null;
  }

  async loadMany(
    ids: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<PipelineRunEntity[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await (dbExecutor ?? getDb())
      .select()
      .from(pipelineRuns)
      .where(inArray(pipelineRuns.id, [...ids]));
    return rows.map(runRowToEntity);
  }

  async lock(
    id: UuidV7,
    dbExecutor: DbExecutor,
  ): Promise<PipelineRunEntity | null> {
    const [row] = await dbExecutor
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, id))
      .limit(1)
      .for("update");
    return row ? runRowToEntity(row) : null;
  }

  async create(
    run: PipelineRunEntity,
    dbExecutor?: DbExecutor,
  ): Promise<PipelineRunEntity> {
    const db = dbExecutor ?? getDb();
    await db.insert(pipelineRuns).values(runEntityToRow(run));
    return await this.reload(run.id, db, "PIPELINE_RUN_INSERT_FAILED");
  }

  async save(
    run: PipelineRunEntity,
    dbExecutor?: DbExecutor,
  ): Promise<PipelineRunEntity> {
    const db = dbExecutor ?? getDb();
    await db
      .update(pipelineRuns)
      .set(runEntityToUpdate(run))
      .where(eq(pipelineRuns.id, run.id));
    return await this.reload(run.id, db, "PIPELINE_RUN_UPDATE_FAILED");
  }

  private async reload(
    id: UuidV7,
    db: DbExecutor,
    code: string,
  ): Promise<PipelineRunEntity> {
    const run = await this.load(id, db);
    if (!run) {
      throw new PersistenceError(`Failed to write pipeline run ${id}`, code);
    }
    return run;
  }

  async listByProjectId(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<PipelineRunEntity[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.projectId, projectId))
      .orderBy(desc(pipelineRuns.createdAt), desc(pipelineRuns.id));
    return rows.map(runRowToEntity);
  }

  async listByWorkItemAndPipelineGraphId(
    workItemId: WorkItemId,
    pipelineGraphId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<PipelineRunEntity[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(pipelineRuns)
      .where(
        and(
          eq(pipelineRuns.workItemId, workItemId),
          eq(pipelineRuns.pipelineGraphId, pipelineGraphId),
        ),
      )
      .orderBy(desc(pipelineRuns.createdAt), desc(pipelineRuns.id));
    return rows.map(runRowToEntity);
  }

  async deleteByWorkItemAndPipelineGraphId(
    workItemId: WorkItemId,
    pipelineGraphId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<UuidV7[]> {
    return await this.deleteRunsWhere(
      and(
        eq(pipelineRuns.workItemId, workItemId),
        eq(pipelineRuns.pipelineGraphId, pipelineGraphId),
      ),
      dbExecutor,
    );
  }

  async deleteByProjectId(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<UuidV7[]> {
    return await this.deleteRunsWhere(
      eq(pipelineRuns.projectId, projectId),
      dbExecutor,
    );
  }

  private async deleteRunsWhere(
    where: SQL | undefined,
    dbExecutor?: DbExecutor,
  ): Promise<UuidV7[]> {
    const db = dbExecutor ?? getDb();
    return await db.transaction(async (tx) => {
      const runIds = (
        await tx.select({ id: pipelineRuns.id }).from(pipelineRuns).where(where)
      ).map((row) => row.id);
      if (runIds.length === 0) {
        return [];
      }
      const taskIds = (
        await tx
          .select({ taskId: nodeVisits.taskId })
          .from(nodeVisits)
          .where(inArray(nodeVisits.pipelineRunId, runIds))
      ).flatMap((row) => (row.taskId ? [row.taskId as UuidV7] : []));
      await tx.delete(pipelineRuns).where(inArray(pipelineRuns.id, runIds));
      return [...new Set(taskIds)];
    });
  }

  async findRunIdByTaskId(taskId: UuidV7, dbExecutor?: DbExecutor) {
    const [row] = await (dbExecutor ?? getDb())
      .select({ pipelineRunId: nodeVisits.pipelineRunId })
      .from(nodeVisits)
      .where(eq(nodeVisits.taskId, taskId))
      .limit(1);
    return (row?.pipelineRunId as UuidV7 | undefined) ?? null;
  }

  findRunStarterByTaskId = findRunStarterByTaskId;

  findVisitByConversationId = findVisitByConversationId;

  async findNodeIdByTaskRunId(
    taskRunId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<{ pipelineRunId: UuidV7; nodeId: string } | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select({
        pipelineRunId: nodeVisits.pipelineRunId,
        nodeId: nodeVisits.nodeId,
      })
      .from(taskRuns)
      .innerJoin(nodeVisits, eq(nodeVisits.taskId, taskRuns.taskId))
      .where(eq(taskRuns.id, taskRunId))
      .limit(1);
    return row
      ? { pipelineRunId: row.pipelineRunId as UuidV7, nodeId: row.nodeId }
      : null;
  }

  async loadHistory(
    pipelineRunId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<PipelineRunHistory> {
    const histories = await this.loadHistories([pipelineRunId], dbExecutor);
    return histories.get(pipelineRunId) ?? emptyHistory();
  }

  async loadHistories(
    pipelineRunIds: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<Map<UuidV7, PipelineRunHistory>> {
    const histories = new Map<UuidV7, PipelineRunHistory>(
      pipelineRunIds.map((id) => [id, emptyHistory()]),
    );
    if (pipelineRunIds.length === 0) {
      return histories;
    }
    const db = dbExecutor ?? getDb();
    const runIds = [...pipelineRunIds];
    const [visitRows, groupRows] = await Promise.all([
      db
        .select({
          visit: nodeVisits,
          conversationId: tasks.conversationId,
        })
        .from(nodeVisits)
        .leftJoin(tasks, eq(tasks.id, nodeVisits.taskId))
        .where(inArray(nodeVisits.pipelineRunId, runIds))
        .orderBy(asc(nodeVisits.createdAt), asc(nodeVisits.id)),
      db
        .select()
        .from(laneGroups)
        .where(inArray(laneGroups.pipelineRunId, runIds))
        .orderBy(asc(laneGroups.createdAt), asc(laneGroups.id)),
    ]);
    const groupIds = groupRows.map((row) => row.id);
    const visitIds = visitRows.map((row) => row.visit.id);
    const [laneRows, runRows] = await Promise.all([
      groupIds.length === 0
        ? Promise.resolve([] as (typeof lanes.$inferSelect)[])
        : db
            .select()
            .from(lanes)
            .where(inArray(lanes.laneGroupId, groupIds))
            .orderBy(asc(lanes.laneGroupId), asc(lanes.index)),
      visitIds.length === 0
        ? Promise.resolve([])
        : db
            .select({
              visitId: nodeVisits.id,
              number: taskRuns.number,
              taskRunId: taskRuns.id,
              status: taskRuns.status,
            })
            .from(taskRuns)
            .innerJoin(nodeVisits, eq(nodeVisits.taskId, taskRuns.taskId))
            .where(inArray(nodeVisits.id, visitIds))
            .orderBy(asc(nodeVisits.id), asc(taskRuns.number)),
    ]);
    const latestRunByVisitId = new Map(
      runRows.map((row) => [row.visitId, row]),
    );

    const runIdByVisitId = new Map(
      visitRows.map(({ visit }) => [visit.id, visit.pipelineRunId as UuidV7]),
    );
    const runIdByGroupId = new Map(
      groupRows.map((row) => [row.id, row.pipelineRunId as UuidV7]),
    );
    for (const { visit, conversationId } of visitRows) {
      histories
        .get(visit.pipelineRunId as UuidV7)
        ?.visits.push(
          visitRowToEntity(
            visit,
            resultTaskIdOf(visit, latestRunByVisitId.get(visit.id)),
            conversationId as UuidV7 | null,
          ),
        );
    }
    for (const row of groupRows) {
      histories
        .get(row.pipelineRunId as UuidV7)
        ?.laneGroups.push(laneGroupRowToEngine(row));
    }
    for (const row of laneRows) {
      const runId = runIdByGroupId.get(row.laneGroupId);
      if (runId) {
        histories.get(runId)?.lanes.push(laneRowToEngine(row));
      }
    }
    for (const row of runRows) {
      const runId = runIdByVisitId.get(row.visitId);
      if (runId) {
        histories.get(runId)?.visitTasks.push({
          visitId: row.visitId,
          attemptNumber: row.number,
          taskId: row.taskRunId,
        });
      }
    }
    return histories;
  }

  async insertVisit(
    visit: NodeVisitEntity,
    dbExecutor?: DbExecutor,
  ): Promise<void> {
    const db = dbExecutor ?? getDb();
    await db.insert(nodeVisits).values(visitEntityToRow(visit));
  }

  async updateVisit(
    visit: NodeVisitEntity,
    dbExecutor?: DbExecutor,
  ): Promise<void> {
    const db = dbExecutor ?? getDb();
    await db
      .update(nodeVisits)
      .set(visitEntityToUpdate(visit))
      .where(eq(nodeVisits.id, visit.id));
  }

  async insertLaneGroup(
    pipelineRunId: UuidV7,
    group: LaneGroup,
    groupLanes: readonly Lane[],
    dbExecutor?: DbExecutor,
  ): Promise<void> {
    const db = dbExecutor ?? getDb();
    await db.insert(laneGroups).values({
      id: group.id,
      pipelineRunId,
      parentLaneId: group.parentLaneId,
      spawnedByVisitId: group.spawnedByVisitId,
      kind: group.kind,
      laneCount: group.laneCount,
      maxConcurrency: group.maxConcurrency,
      toleratedFailuresJson: group.toleratedFailures,
      status: group.status,
    });
    if (groupLanes.length > 0) {
      await db.insert(lanes).values(groupLanes.map(laneEngineToRow));
    }
  }

  async insertLane(lane: Lane, dbExecutor?: DbExecutor): Promise<void> {
    const db = dbExecutor ?? getDb();
    await db.insert(lanes).values(laneEngineToRow(lane));
  }

  async updateLaneGroup(
    groupId: UuidV7,
    patch: LaneGroupPatch,
    dbExecutor?: DbExecutor,
  ): Promise<void> {
    const db = dbExecutor ?? getDb();
    await db
      .update(laneGroups)
      .set({ status: patch.status, laneCount: patch.laneCount })
      .where(eq(laneGroups.id, groupId));
  }

  async updateLane(
    laneId: UuidV7,
    patch: LanePatch,
    dbExecutor?: DbExecutor,
  ): Promise<void> {
    const db = dbExecutor ?? getDb();
    await db
      .update(lanes)
      .set(lanePatchToUpdate(patch))
      .where(eq(lanes.id, laneId));
  }

  async setVisitTask(
    visitId: UuidV7,
    taskId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<void> {
    const db = dbExecutor ?? getDb();
    await db
      .update(nodeVisits)
      .set({ taskId })
      .where(eq(nodeVisits.id, visitId));
  }
}

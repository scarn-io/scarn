import { asc, eq, inArray } from "drizzle-orm";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  laneGroups,
  lanes,
  nodeVisits,
  taskRuns,
  tasks,
} from "@scarn/core/lib/db/schema";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { Logger } from "@scarn/observability/logging";
import type { PipelineRunHistory } from "../application/pipeline-run-repo";
import {
  describeLaneRow,
  describeVisitRow,
  laneGroupRowToEngine,
  readLaneRow,
  readVisitRow,
  resultTaskIdOf,
} from "./pipeline-run-row-mappers";

export const emptyHistory = (): PipelineRunHistory => ({
  visits: [],
  laneGroups: [],
  lanes: [],
  visitTasks: [],
});

type LoadedHistories = {
  histories: Map<UuidV7, PipelineRunHistory>;
  unreadable: Map<UuidV7, string>;
};

/**
 * The runs' histories, and why each run whose lanes or visits don't read is
 * unreadable. An unreadable row is logged at `error` and its run's history is
 * left incomplete; callers drop it (`loadHistories`) or throw
 * (`loadHistory`).
 */
export const readHistories = async (
  pipelineRunIds: readonly UuidV7[],
  db: DbExecutor,
  logger: Logger,
): Promise<LoadedHistories> => {
  const histories = new Map<UuidV7, PipelineRunHistory>(
    pipelineRunIds.map((id) => [id, emptyHistory()]),
  );
  const unreadable = new Map<UuidV7, string>();
  if (pipelineRunIds.length === 0) {
    return { histories, unreadable };
  }
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
  const latestRunByVisitId = new Map(runRows.map((row) => [row.visitId, row]));

  const runIdByVisitId = new Map(
    visitRows.map(({ visit }) => [visit.id, visit.pipelineRunId as UuidV7]),
  );
  const runIdByGroupId = new Map(
    groupRows.map((row) => [row.id, row.pipelineRunId as UuidV7]),
  );
  for (const { visit, conversationId } of visitRows) {
    const runId = visit.pipelineRunId as UuidV7;
    const read = readVisitRow(
      visit,
      resultTaskIdOf(visit, latestRunByVisitId.get(visit.id)),
      conversationId as UuidV7 | null,
    );
    if (read.success) {
      histories.get(runId)?.visits.push(read.value);
    } else {
      logger.error(
        { ...describeVisitRow(visit), reason: read.reason },
        "Stored row is unreadable; skipping its run's history",
      );
      unreadable.set(runId, `node visit ${visit.id}: ${read.reason}`);
    }
  }
  for (const row of groupRows) {
    histories
      .get(row.pipelineRunId as UuidV7)
      ?.laneGroups.push(laneGroupRowToEngine(row));
  }
  for (const row of laneRows) {
    const runId = runIdByGroupId.get(row.laneGroupId);
    if (!runId) {
      continue;
    }
    const read = readLaneRow(row);
    if (read.success) {
      histories.get(runId)?.lanes.push(read.value);
    } else {
      logger.error(
        {
          ...describeLaneRow(row),
          pipelineRunId: runId,
          reason: read.reason,
        },
        "Stored row is unreadable; skipping its run's history",
      );
      unreadable.set(runId, `lane ${row.id}: ${read.reason}`);
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
  return { histories, unreadable };
};

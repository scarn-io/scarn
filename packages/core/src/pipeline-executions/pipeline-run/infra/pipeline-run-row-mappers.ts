import type {
  laneGroups,
  lanes,
  nodeVisits,
  pipelineRuns,
} from "@scarn/core/lib/db/schema";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import { PersistenceError } from "@scarn/core/lib/errors";
import type { StoredReadResult } from "@scarn/core/lib/db/stored-json";
import type {
  Lane,
  LaneGroup,
  LanePatch,
  ToleratedFailures,
} from "../domain/engine/types";
import { PipelineRunEntity } from "../domain/pipeline-run-entity";
import { NodeVisitEntity } from "../domain/node-visit-entity";
import {
  CURRENT_LANE_SCHEMA_VERSION,
  CURRENT_NODE_VISIT_SCHEMA_VERSION,
  readStoredLane,
  readStoredNodeVisit,
  readStoredPipelineRunError,
} from "../contracts/pipeline-run-state-stored";

/**
 * Row ↔ domain mappers for the pipeline-run tables. JSON columns are read
 * through the stored readers in `pipeline-run-state-stored.ts`; a row that
 * doesn't read throws `PersistenceError` with a `<TABLE>_ROW_UNREADABLE`
 * code from the `*RowToEntity` / `*RowToEngine` mappers, and `read*Row`
 * returns the failure for callers that skip it. Writers always write the
 * current schema version.
 */

type RunRow = typeof pipelineRuns.$inferSelect;
type VisitRow = typeof nodeVisits.$inferSelect;
type LaneGroupRow = typeof laneGroups.$inferSelect;
type LaneRow = typeof lanes.$inferSelect;

const valueOrThrow = <T>(
  read: StoredReadResult<T>,
  what: string,
  code: string,
): T => {
  if (!read.success) {
    throw new PersistenceError(`${what} is unreadable: ${read.reason}`, code);
  }
  return read.value;
};

export const readRunRow = (
  row: RunRow,
): StoredReadResult<PipelineRunEntity> => {
  const error = readStoredPipelineRunError(row.errorJson);
  if (!error.success) {
    return error;
  }
  return {
    success: true,
    value: PipelineRunEntity.rehydrate({
      id: row.id as UuidV7,
      projectId: row.projectId as UuidV7,
      workItemId: row.workItemId as UuidV7,
      pipelineGraphId: row.pipelineGraphId as UuidV7,
      pipelineGraphVersionId: row.pipelineGraphVersionId as UuidV7,
      status: row.status,
      endNodeId: row.endNodeId,
      errorJson: error.value as AnyJsonValue | null,
      triggeredByUserId: row.triggeredByUserId as UuidV7 | null,
      startedByAutomationId: row.startedByAutomationId as UuidV7 | null,
      cancelledByUserId: row.cancelledByUserId as UuidV7 | null,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }),
  };
};

export const runRowToEntity = (row: RunRow): PipelineRunEntity =>
  valueOrThrow(
    readRunRow(row),
    `pipeline run ${row.id}`,
    "PIPELINE_RUN_ROW_UNREADABLE",
  );

/** The log fields that identify a skipped run row. */
export const describeRunRow = (row: RunRow) => ({
  table: "pipeline_runs",
  pipelineRunId: row.id,
  projectId: row.projectId,
});

/** The run columns that change after insert. */
export const runEntityToUpdate = (run: PipelineRunEntity) => ({
  status: run.status,
  endNodeId: run.endNodeId,
  errorJson: run.errorJson,
  cancelledByUserId: run.cancelledByUserId,
  startedAt: run.startedAt,
  completedAt: run.completedAt,
  updatedAt: run.updatedAt ?? new Date(),
});

export const runEntityToRow = (run: PipelineRunEntity) => ({
  id: run.id,
  projectId: run.projectId,
  workItemId: run.workItemId,
  pipelineGraphId: run.pipelineGraphId,
  pipelineGraphVersionId: run.pipelineGraphVersionId,
  triggeredByUserId: run.triggeredByUserId,
  startedByAutomationId: run.startedByAutomationId,
  createdAt: run.createdAt ?? new Date(),
  ...runEntityToUpdate(run),
});

/**
 * A step visit's result run: its latest run, when the visit ended by that run
 * succeeding. A visit a person ended stores its own `result` instead.
 */
export const resultTaskIdOf = (
  visit: VisitRow,
  latestRun: { taskRunId: string; status: string } | undefined,
): UuidV7 | null =>
  visit.nodeKind === "step" &&
  (visit.status === "succeeded" || visit.status === "superseded") &&
  visit.resultJson === null &&
  latestRun?.status === "succeeded"
    ? (latestRun.taskRunId as UuidV7)
    : null;

/**
 * `resultTaskId` is not a column: the loader derives it from the visit's runs
 * with `resultTaskIdOf`.
 */
/**
 * `conversationId` is the visit's Task's (`tasks.conversation_id`). A wait
 * visit whose `result` doesn't match its shapes is unreadable too.
 */
export const readVisitRow = (
  row: VisitRow,
  resultTaskId: UuidV7 | null = null,
  conversationId: UuidV7 | null = null,
): StoredReadResult<NodeVisitEntity> => {
  const read = readStoredNodeVisit(row.schemaVersion, row);
  if (!read.success) {
    return read;
  }
  try {
    return {
      success: true,
      value: NodeVisitEntity.rehydrate({
        id: row.id as UuidV7,
        pipelineRunId: row.pipelineRunId as UuidV7,
        nodeId: row.nodeId,
        nodeKind: row.nodeKind,
        laneId: row.laneId as UuidV7 | null,
        fromVisitId: row.fromVisitId as UuidV7 | null,
        fromLaneGroupId: row.fromLaneGroupId as UuidV7 | null,
        ...read.value,
        status: row.status,
        taskId: row.taskId as UuidV7 | null,
        resultTaskId,
        createdByUserId: row.createdByUserId as UuidV7 | null,
        resolvedByUserId: row.resolvedByUserId as UuidV7 | null,
        resolvedAt: row.resolvedAt,
        createdAt: row.createdAt,
        completedAt: row.completedAt,
        conversationId,
      }),
    };
  } catch (error: unknown) {
    return {
      success: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};

export const visitRowToEntity = (
  row: VisitRow,
  resultTaskId: UuidV7 | null = null,
  conversationId: UuidV7 | null = null,
): NodeVisitEntity =>
  valueOrThrow(
    readVisitRow(row, resultTaskId, conversationId),
    `node visit ${row.id}`,
    "NODE_VISIT_ROW_UNREADABLE",
  );

/** The visit columns that change after insert. */
export const visitEntityToUpdate = (visit: NodeVisitEntity) => {
  const row = visit.toRow();
  return {
    nodeId: row.nodeId,
    nodeKind: row.nodeKind,
    laneId: row.laneId,
    fromVisitId: row.fromVisitId,
    fromLaneGroupId: row.fromLaneGroupId,
    transitionJson: row.transition,
    routingJson: row.routing,
    status: row.status,
    inputJson: row.input,
    taskId: row.taskId,
    resultJson: row.result,
    errorJson: row.error,
    createdByUserId: row.createdByUserId,
    resolvedByUserId: row.resolvedByUserId,
    resolvedAt: row.resolvedAt,
    completedAt: row.completedAt,
    schemaVersion: CURRENT_NODE_VISIT_SCHEMA_VERSION,
  };
};

/** The log fields that identify a skipped visit row. */
export const describeVisitRow = (row: VisitRow) => ({
  table: "node_visits",
  nodeVisitId: row.id,
  pipelineRunId: row.pipelineRunId,
  schemaVersion: row.schemaVersion,
});

export const visitEntityToRow = (visit: NodeVisitEntity) => {
  const row = visit.toRow();
  return {
    id: row.id,
    pipelineRunId: row.pipelineRunId,
    createdAt: row.createdAt,
    ...visitEntityToUpdate(visit),
  };
};

const toleratedFailuresOf = (row: LaneGroupRow): ToleratedFailures =>
  row.toleratedFailuresPercent === null
    ? { count: row.toleratedFailuresCount ?? 0 }
    : { percent: row.toleratedFailuresPercent };

export const laneGroupRowToEngine = (row: LaneGroupRow): LaneGroup => ({
  id: row.id,
  parentLaneId: row.parentLaneId,
  spawnedByVisitId: row.spawnedByVisitId,
  kind: row.kind,
  laneCount: row.laneCount,
  maxConcurrency: row.maxConcurrency,
  toleratedFailures: toleratedFailuresOf(row),
  status: row.status,
});

/** A lane group's insert values. */
export const laneGroupEngineToRow = (
  pipelineRunId: UuidV7,
  group: LaneGroup,
) => ({
  id: group.id,
  pipelineRunId,
  parentLaneId: group.parentLaneId,
  spawnedByVisitId: group.spawnedByVisitId,
  kind: group.kind,
  laneCount: group.laneCount,
  maxConcurrency: group.maxConcurrency,
  toleratedFailuresCount:
    "count" in group.toleratedFailures ? group.toleratedFailures.count : null,
  toleratedFailuresPercent:
    "percent" in group.toleratedFailures
      ? group.toleratedFailures.percent
      : null,
  status: group.status,
});

export const readLaneRow = (row: LaneRow): StoredReadResult<Lane> => {
  const read = readStoredLane(row.schemaVersion, row);
  if (!read.success) {
    return read;
  }
  return {
    success: true,
    value: {
      id: row.id,
      laneGroupId: row.laneGroupId,
      index: row.index,
      origin: row.origin,
      status: row.status,
      arrivedAtNodeId: row.arrivedAtNodeId,
      arrivedFromVisitId: row.arrivedFromVisitId,
      mergedIntoVisitId: row.mergedIntoVisitId,
      ...read.value,
    },
  };
};

export const laneRowToEngine = (row: LaneRow): Lane =>
  valueOrThrow(readLaneRow(row), `lane ${row.id}`, "LANE_ROW_UNREADABLE");

/** The log fields that identify a skipped lane row. */
export const describeLaneRow = (row: LaneRow) => ({
  table: "lanes",
  laneId: row.id,
  laneGroupId: row.laneGroupId,
  schemaVersion: row.schemaVersion,
});

/** The lane columns a patch sets; fields the patch leaves out are untouched. */
export const lanePatchToUpdate = (patch: LanePatch) => ({
  ...(patch.status === undefined ? {} : { status: patch.status }),
  ...(patch.arrivedAtNodeId === undefined
    ? {}
    : { arrivedAtNodeId: patch.arrivedAtNodeId }),
  ...(patch.arrivalArgs === undefined
    ? {}
    : { arrivalArgsJson: patch.arrivalArgs }),
  ...(patch.arrivedFromVisitId === undefined
    ? {}
    : { arrivedFromVisitId: patch.arrivedFromVisitId }),
  ...(patch.arrivalTransition === undefined
    ? {}
    : { arrivalTransitionJson: patch.arrivalTransition }),
  ...(patch.mergedIntoVisitId === undefined
    ? {}
    : { mergedIntoVisitId: patch.mergedIntoVisitId }),
});

export const laneEngineToRow = (lane: Lane) => ({
  id: lane.id,
  laneGroupId: lane.laneGroupId,
  index: lane.index,
  itemJson: lane.item,
  routeJson: lane.route,
  origin: lane.origin,
  status: lane.status,
  arrivedAtNodeId: lane.arrivedAtNodeId,
  arrivalArgsJson: lane.arrivalArgs,
  arrivedFromVisitId: lane.arrivedFromVisitId,
  arrivalTransitionJson: lane.arrivalTransition,
  mergedIntoVisitId: lane.mergedIntoVisitId,
  schemaVersion: CURRENT_LANE_SCHEMA_VERSION,
});

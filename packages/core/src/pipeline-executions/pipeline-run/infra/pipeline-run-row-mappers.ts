import type {
  laneGroups,
  lanes,
  nodeVisits,
  pipelineRuns,
} from "@scarn/core/lib/db/schema";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import type {
  JsonObject,
  JsonValue,
} from "@scarn/sdk/contracts/pipeline-document";
import type {
  Routing,
  EngineError,
  Lane,
  LaneGroup,
  LanePatch,
  ToleratedFailures,
  VisitTransition,
} from "../domain/engine/types";
import { PipelineRunEntity } from "../domain/pipeline-run-entity";
import { NodeVisitEntity } from "../domain/node-visit-entity";

type RunRow = typeof pipelineRuns.$inferSelect;
type VisitRow = typeof nodeVisits.$inferSelect;
type LaneGroupRow = typeof laneGroups.$inferSelect;
type LaneRow = typeof lanes.$inferSelect;

export const runRowToEntity = (row: RunRow): PipelineRunEntity =>
  PipelineRunEntity.rehydrate({
    id: row.id as UuidV7,
    projectId: row.projectId as UuidV7,
    workItemId: row.workItemId as UuidV7,
    pipelineGraphId: row.pipelineGraphId as UuidV7,
    pipelineGraphVersionId: row.pipelineGraphVersionId as UuidV7,
    status: row.status,
    endNodeId: row.endNodeId,
    errorJson: row.errorJson as AnyJsonValue | null,
    triggeredByUserId: row.triggeredByUserId as UuidV7 | null,
    startedByAutomationId: row.startedByAutomationId as UuidV7 | null,
    cancelledByUserId: row.cancelledByUserId as UuidV7 | null,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
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
/** `conversationId` is the visit's Task's (`tasks.conversation_id`). */
export const visitRowToEntity = (
  row: VisitRow,
  resultTaskId: UuidV7 | null = null,
  conversationId: UuidV7 | null = null,
): NodeVisitEntity =>
  NodeVisitEntity.rehydrate({
    id: row.id as UuidV7,
    pipelineRunId: row.pipelineRunId as UuidV7,
    nodeId: row.nodeId,
    nodeKind: row.nodeKind,
    laneId: row.laneId as UuidV7 | null,
    fromVisitId: row.fromVisitId as UuidV7 | null,
    fromLaneGroupId: row.fromLaneGroupId as UuidV7 | null,
    transition: row.transitionJson as VisitTransition,
    routing: row.routingJson as Routing | null,
    status: row.status,
    input: row.inputJson as JsonObject,
    taskId: row.taskId as UuidV7 | null,
    resultTaskId,
    result: row.resultJson as JsonValue | null,
    error: row.errorJson as EngineError | null,
    createdByUserId: row.createdByUserId as UuidV7 | null,
    resolvedByUserId: row.resolvedByUserId as UuidV7 | null,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    conversationId,
  });

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
  };
};

export const visitEntityToRow = (visit: NodeVisitEntity) => {
  const row = visit.toRow();
  return {
    id: row.id,
    pipelineRunId: row.pipelineRunId,
    createdAt: row.createdAt,
    ...visitEntityToUpdate(visit),
  };
};

export const laneGroupRowToEngine = (row: LaneGroupRow): LaneGroup => ({
  id: row.id,
  parentLaneId: row.parentLaneId,
  spawnedByVisitId: row.spawnedByVisitId,
  kind: row.kind,
  laneCount: row.laneCount,
  maxConcurrency: row.maxConcurrency,
  toleratedFailures: row.toleratedFailuresJson as ToleratedFailures,
  status: row.status,
});

export const laneRowToEngine = (row: LaneRow): Lane => ({
  id: row.id,
  laneGroupId: row.laneGroupId,
  index: row.index,
  item: (row.itemJson as JsonValue | null) ?? null,
  route: row.routeJson as VisitTransition,
  origin: row.origin,
  status: row.status,
  arrivedAtNodeId: row.arrivedAtNodeId,
  arrivalArgs: row.arrivalArgsJson as JsonObject | null,
  arrivedFromVisitId: row.arrivedFromVisitId,
  arrivalTransition: row.arrivalTransitionJson as VisitTransition | null,
  mergedIntoVisitId: row.mergedIntoVisitId,
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
});

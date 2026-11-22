import type {
  LaneContract,
  NodeVisitContract,
  PipelineExecutionContract,
} from "@scarn/api/frontend-contracts";
import { latestVisitTask } from "./visit-status";

type LaneRefs = Pick<
  PipelineExecutionContract,
  "lanes" | "laneGroups" | "visits"
>;

const identity = (nodeId: string) => nodeId;

function firstLaneVisit(
  execution: LaneRefs,
  laneId: string,
): NodeVisitContract | undefined {
  return execution.visits
    .filter((visit) => visit.laneId === laneId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
}

function laneLabelWithin(
  execution: LaneRefs,
  lane: LaneContract,
  nodeTitle: (nodeId: string) => string,
  seen: ReadonlySet<string>,
): string {
  if (lane.origin === "merge") {
    const mergeVisit = execution.visits.find(
      (visit) =>
        visit.laneId === lane.id &&
        visit.transition.kind === "merge" &&
        visit.fromLaneGroupId === lane.laneGroupId,
    );
    const nextSeen = new Set([...seen, lane.id]);
    const sources = mergeVisit
      ? execution.lanes
          .filter(
            (candidate) =>
              candidate.laneGroupId === lane.laneGroupId &&
              candidate.mergedIntoVisitId === mergeVisit.id &&
              !nextSeen.has(candidate.id),
          )
          .sort((left, right) => left.index - right.index)
          .map((candidate) =>
            laneLabelWithin(execution, candidate, nodeTitle, nextSeen),
          )
      : [];
    return sources.length > 0 ? `Merged (${sources.join(" + ")})` : "Merged";
  }
  const group = execution.laneGroups.find(
    (candidate) => candidate.id === lane.laneGroupId,
  );
  if (group?.kind === "all") {
    if (lane.route.kind === "otherwise") return "Otherwise";
    const first = firstLaneVisit(execution, lane.id);
    return first
      ? nodeTitle(first.nodeId)
      : `Route ${String(lane.route.index + 1)}`;
  }
  return `Item ${String(lane.index + 1)}`;
}

/**
 * A lane's name: `Item N` for an `each` lane, the route's target node title
 * (or `Otherwise`) for an `all` lane, and `Merged (A + B)` for the
 * continuation lane of a partial merge, naming the lanes that merged into it.
 */
export function laneLabel(
  execution: LaneRefs,
  lane: LaneContract,
  nodeTitle: (nodeId: string) => string = identity,
): string {
  return laneLabelWithin(execution, lane, nodeTitle, new Set());
}

/**
 * A short name for one of a node's visits: the label of the lane it runs in
 * (see `laneLabel`), otherwise its position among the node's visits.
 */
export function visitLabel(
  execution: LaneRefs,
  visit: NodeVisitContract,
  index: number,
  nodeTitle: (nodeId: string) => string = identity,
): string {
  const lane =
    visit.laneId === null
      ? undefined
      : execution.lanes.find((candidate) => candidate.id === visit.laneId);
  if (lane) return laneLabel(execution, lane, nodeTitle);
  return `Visit ${String(index + 1)}`;
}

/** Start/end timestamps of a visit's latest task, for the elapsed clock. */
export function visitTiming(visit: NodeVisitContract): {
  startedAt: string;
  completedAt: string | null;
} | null {
  const task = latestVisitTask(visit);
  if (task?.startedAt) {
    return { startedAt: task.startedAt, completedAt: task.completedAt };
  }
  if (visit.nodeKind === "wait") {
    return { startedAt: visit.createdAt, completedAt: visit.completedAt };
  }
  return null;
}

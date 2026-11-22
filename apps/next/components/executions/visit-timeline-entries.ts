import type {
  NodeVisitContract,
  PipelineExecutionContract,
} from "@scarn/api/frontend-contracts";
import type { ExecutionStepItem } from "./execution-step-items";
import { laneLabel } from "./visit-labels";
import {
  deriveVisitDisplayStatus,
  VISIT_STATUS_LABELS,
  type VisitDisplayStatus,
} from "./visit-status";

/** One row of the run rail's timeline: a visit, named and annotated. */
export type VisitTimelineEntry = {
  visit: NodeVisitContract;
  status: VisitDisplayStatus;
  /** The node's title, then the lane's name for a visit in a lane. */
  label: string;
  /** Runs in a lane (an `each` item, an `all` route, a merge continuation). */
  inLane: boolean;
  /** What happened there: the choice made, the error, how the run ended. */
  note: string;
  /** Lanes a merge visit joined; 0 for any other visit. */
  mergedLanes: number;
};

type TimelineRun = Pick<
  PipelineExecutionContract,
  "visits" | "lanes" | "laneGroups" | "error" | "endNodeId"
>;

type VisitResult = NodeVisitContract["result"];

const resultField = (result: VisitResult, key: string) =>
  result && typeof result === "object" && !Array.isArray(result)
    ? result[key]
    : undefined;

const readString = (result: VisitResult, key: string): string | null => {
  const field = resultField(result, key);
  return typeof field === "string" ? field : null;
};

const readBoolean = (result: VisitResult, key: string): boolean | null => {
  const field = resultField(result, key);
  return typeof field === "boolean" ? field : null;
};

function visitNote(
  run: TimelineRun,
  visit: NodeVisitContract,
  status: VisitDisplayStatus,
  viewerUserId: string | null,
): string {
  if (visit.nodeKind === "fail") {
    const reason =
      visit.error?.name ??
      (run.endNodeId === visit.nodeId ? run.error?.name : undefined);
    return reason ? `ended · ${reason}` : "ended";
  }
  if (visit.nodeKind === "succeed") return "finished";
  if (visit.error) return visit.error.message || visit.error.name;
  if (visit.waitFor === "decision") {
    const action = readString(visit.result, "action");
    if (action) {
      const chooser =
        viewerUserId !== null && visit.resolvedByUserId === viewerUserId
          ? "you chose"
          : "chose";
      return `${chooser} ${action}`;
    }
  }
  if (visit.waitFor === "reply") {
    const replied = readBoolean(visit.result, "replied");
    if (replied === true) return "answered";
    if (replied === false) return "continued without a reply";
  }
  return VISIT_STATUS_LABELS[status].toLowerCase();
}

/**
 * Every visit of a run, oldest first, as the rail's timeline shows it. Built
 * from the same visits `buildExecutionStepItems` groups by node, so a row and
 * its step always agree.
 */
export function buildVisitTimeline(
  run: TimelineRun,
  steps: readonly ExecutionStepItem[],
  viewerUserId: string | null = null,
): VisitTimelineEntry[] {
  const nodeTitle = (nodeId: string) =>
    steps.find((step) => step.nodeId === nodeId)?.title ?? nodeId;
  return steps
    .flatMap((step) => step.visits)
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    )
    .map((visit) => {
      const status = deriveVisitDisplayStatus(visit);
      const lane =
        visit.laneId === null
          ? undefined
          : run.lanes.find((candidate) => candidate.id === visit.laneId);
      const title = nodeTitle(visit.nodeId);
      return {
        visit,
        status,
        label: lane ? `${title} · ${laneLabel(run, lane, nodeTitle)}` : title,
        inLane: visit.laneId !== null,
        note: visitNote(run, visit, status, viewerUserId),
        mergedLanes:
          visit.transition.kind === "merge"
            ? run.lanes.filter((lane) => lane.mergedIntoVisitId === visit.id)
                .length
            : 0,
      };
    });
}

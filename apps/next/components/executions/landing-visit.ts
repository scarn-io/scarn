import type {
  NodeVisitContract,
  PipelineExecutionContract,
} from "@scarn/api/frontend-contracts";
import { deriveVisitDisplayStatus } from "./visit-status";

/**
 * Where opening a pipeline run lands when the URL names no visit, and the
 * run's shape for its header. A visit is "live" unless a rerun superseded
 * it.
 */

type RunVisits = Pick<PipelineExecutionContract, "visits">;

const oldestFirst = (visits: readonly NodeVisitContract[]) =>
  [...visits].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );

export function liveVisits(execution: RunVisits): NodeVisitContract[] {
  return oldestFirst(execution.visits).filter(
    (visit) => visit.status !== "superseded",
  );
}

/** A step that failed without routing on: the run stopped there. */
function crashedVisit(
  live: readonly NodeVisitContract[],
): NodeVisitContract | undefined {
  return live.find(
    (visit) =>
      visit.status === "failed" &&
      visit.nodeKind !== "fail" &&
      !live.some((other) => other.fromVisitId === visit.id),
  );
}

/**
 * What's waiting, else what's running, else the crashed step, else the end
 * the run reached, else the last visit. `null` when the run has no visits.
 */
export function landingVisit(execution: RunVisits): NodeVisitContract | null {
  const live = liveVisits(execution);
  return (
    live.find((visit) => visit.status === "waiting") ??
    live.find((visit) => deriveVisitDisplayStatus(visit) === "running") ??
    crashedVisit(live) ??
    live.find(
      (visit) => visit.nodeKind === "succeed" || visit.nodeKind === "fail",
    ) ??
    live.at(-1) ??
    oldestFirst(execution.visits).at(-1) ??
    null
  );
}

/** The run's visits so far, leaving out those a rerun superseded. */
export function stepsSoFar(execution: RunVisits): number {
  return liveVisits(execution).length;
}

/** How many visits are open at once: running, queued or waiting. */
export function placesAtOnce(execution: RunVisits): number {
  return execution.visits.filter(
    (visit) => visit.status === "active" || visit.status === "waiting",
  ).length;
}

import type { RunVisit, RunWithVisits } from "./run-api-types";

/**
 * Maps a step key (`--step`) and attempt number (`--attempt`) to one visit
 * of a pipeline run. A node's visits (reruns, loop passes, lanes) are numbered
 * 1, 2, … oldest first; with no attempt the default visit is picked the way
 * the web UI's step rail does: the latest non-superseded visit, else the
 * latest.
 */

export type ResolvedStepVisit = {
  visit: RunVisit;
  /** 1-based position of `visit` among the node's visits, oldest first. */
  attemptNumber: number;
  attemptCount: number;
};

/** Every visit to `nodeId`, oldest first. */
export function visitsForNode(
  run: Pick<RunWithVisits, "visits">,
  nodeId: string,
): RunVisit[] {
  return run.visits
    .filter((visit) => visit.nodeId === nodeId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function defaultVisitIndex(visits: readonly RunVisit[]): number {
  for (let index = visits.length - 1; index >= 0; index -= 1) {
    if (visits[index]?.status !== "superseded") return index;
  }
  return visits.length - 1;
}

export function resolveStepVisit(
  run: Pick<RunWithVisits, "id" | "visits">,
  stepKey: string,
  attemptNumber: number | undefined,
): ResolvedStepVisit {
  const visits = visitsForNode(run, stepKey);
  if (visits.length === 0) {
    const known = [...new Set(run.visits.map((visit) => visit.nodeId))];
    throw new Error(
      `Step "${stepKey}" has no visits in pipeline run ${run.id}. Visited steps: ${known.join(", ") || "(none)"}.`,
    );
  }
  const index =
    attemptNumber === undefined ? defaultVisitIndex(visits) : attemptNumber - 1;
  const visit = visits[index];
  if (visit === undefined) {
    throw new Error(
      `Attempt ${String(attemptNumber)} not found for step "${stepKey}" of pipeline run ${run.id}. Available attempts: ${visits.map((_, position) => String(position + 1)).join(", ")}.`,
    );
  }
  return { visit, attemptNumber: index + 1, attemptCount: visits.length };
}

import type {
  NodeVisitContract,
  VisitTaskContract,
} from "@scarn/api/frontend-contracts";

/**
 * What the run view shows for one visit. An `active` visit is split by its
 * latest Task: `running` once claimed, `abandoned`/`timeout` when the Task's
 * liveness clocks say it died, else `queued`. Nothing here is stored.
 */
export type VisitDisplayStatus =
  | "queued"
  | "running"
  | "abandoned"
  | "timeout"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "superseded";

export function latestVisitTask(
  visit: Pick<NodeVisitContract, "tasks">,
): VisitTaskContract | null {
  return visit.tasks.at(-1) ?? null;
}

export function deriveVisitDisplayStatus(
  visit: Pick<NodeVisitContract, "status" | "tasks">,
): VisitDisplayStatus {
  if (visit.status !== "active") return visit.status;
  const task = latestVisitTask(visit);
  switch (task?.status) {
    case "running":
      return "running";
    case "abandoned":
      return "abandoned";
    case "timeout":
      return "timeout";
    default:
      return "queued";
  }
}

/** Worst first: what a node with many visits (lanes, reruns) shows. */
const SEVERITY_ORDER: readonly VisitDisplayStatus[] = [
  "failed",
  "timeout",
  "abandoned",
  "waiting",
  "running",
  "queued",
  "cancelled",
  "succeeded",
  "superseded",
];

export function pickWorstVisitStatus(
  statuses: readonly VisitDisplayStatus[],
): VisitDisplayStatus | null {
  let worst: VisitDisplayStatus | null = null;
  for (const status of statuses) {
    if (
      worst === null ||
      SEVERITY_ORDER.indexOf(status) < SEVERITY_ORDER.indexOf(worst)
    ) {
      worst = status;
    }
  }
  return worst;
}

export const VISIT_STATUS_LABELS: Record<VisitDisplayStatus, string> = {
  queued: "Queued",
  running: "Running",
  abandoned: "Abandoned",
  timeout: "Timed out",
  waiting: "Waiting",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  superseded: "Superseded",
};

export function isLiveVisitStatus(status: VisitDisplayStatus | null): boolean {
  return status === "queued" || status === "running";
}

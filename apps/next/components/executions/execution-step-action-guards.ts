import type {
  NodeVisitContract,
  PipelineExecutionContract,
  TaskRunContract,
} from "@scarn/api/frontend-contracts";
import type { Next } from "@scarn/sdk/contracts/pipeline-document";
import { overruleAllowedByDocument, readVisitRouting } from "./overrule-routes";
import { deriveVisitDisplayStatus } from "./visit-status";

type RunRefs = Pick<
  PipelineExecutionContract,
  "status" | "lanes" | "laneGroups"
>;

function inFailedLaneGroup(
  execution: RunRefs,
  visit: Pick<NodeVisitContract, "laneId">,
): boolean {
  if (visit.laneId === null) return false;
  const lane = execution.lanes.find(
    (candidate) => candidate.id === visit.laneId,
  );
  const group = execution.laneGroups.find(
    (candidate) => candidate.id === lane?.laneGroupId,
  );
  return group?.status === "failed";
}

/**
 * Whether a visit can be rerun, mirroring the engine's own rerun checks
 * (`core`'s `pipeline-run/domain/engine/rerun.ts`): step and wait visits
 * only, not superseded, not in a failed lane group, and not in a cancelled
 * run. The server stays the source of truth.
 */
export function canRerunVisit(
  execution: RunRefs,
  visit: NodeVisitContract | null,
): visit is NodeVisitContract {
  return (
    visit !== null &&
    execution.status !== "cancelled" &&
    (visit.nodeKind === "step" || visit.nodeKind === "wait") &&
    visit.status !== "superseded" &&
    !inFailedLaneGroup(execution, visit)
  );
}

/**
 * Whether a person could overrule the routes a visit took, mirroring the
 * engine's checks (`core`'s `pipeline-run/domain/engine/overrule.ts`): a
 * succeeded step visit that `canRerunVisit` allows, whose node's document
 * allows some change (`overruleAllowedByDocument`). The server stays the
 * source of truth.
 */
export function canOverruleVisit(
  execution: RunRefs,
  visit: NodeVisitContract | null,
  next: Next | undefined,
): visit is NodeVisitContract {
  if (!canRerunVisit(execution, visit)) return false;
  if (visit.nodeKind !== "step" || visit.status !== "succeeded") return false;
  const taken = readVisitRouting(visit.routing)?.taken;
  return taken != null && overruleAllowedByDocument(next, taken);
}

/** The first visit of the run, which "Re-run from start" reruns. */
export function startVisit(
  execution: Pick<PipelineExecutionContract, "visits">,
): NodeVisitContract | null {
  return (
    execution.visits.find(
      (visit) =>
        visit.transition.kind === "start" && visit.status !== "superseded",
    ) ?? null
  );
}

type WaitingVisitRef = Pick<
  NodeVisitContract,
  "nodeKind" | "status" | "waitFor"
>;

/** A decision wait visit a person can decide now. */
export function isAwaitingDecision(visit: WaitingVisitRef | null): boolean {
  return (
    visit?.nodeKind === "wait" &&
    visit.status === "waiting" &&
    visit.waitFor === "decision"
  );
}

/** A reply wait visit still waiting on an answer to its question. */
export function isAwaitingReply(visit: WaitingVisitRef | null): boolean {
  return (
    visit?.nodeKind === "wait" &&
    visit.status === "waiting" &&
    visit.waitFor === "reply"
  );
}

export type StepMessageGate =
  | { kind: "hidden" }
  | { kind: "disabled"; reason: string; latestHref?: string }
  | { kind: "ready" };

export type StepMessageGateInput = {
  canWriteExecutions: boolean;
  execution: RunRefs;
  /** The selected visit, or `null` when the node hasn't been visited. */
  visit: NodeVisitContract | null;
  /** The node's kind from the document, used before it has a visit. */
  nodeKind: NodeVisitContract["nodeKind"];
  /** Kind of the visit's latest task; `null` while it hasn't loaded. */
  taskKind: TaskRunContract["kind"] | null;
  /** The node's current visit, linked from a superseded visit's disabled state. */
  currentVisitHref: string | null;
  isMutating: boolean;
};

/**
 * Whether the step message box is hidden, disabled (with a reason), or ready.
 * Messages go to agent step visits only and rerun that visit, so the gate
 * mirrors `canRerunVisit` plus the agent check.
 */
export function resolveStepMessageGate(
  input: StepMessageGateInput,
): StepMessageGate {
  const { visit } = input;
  if (!input.canWriteExecutions) return { kind: "hidden" };
  if ((visit?.nodeKind ?? input.nodeKind) !== "step") return { kind: "hidden" };
  if (!visit) {
    return { kind: "disabled", reason: "This step hasn't run yet" };
  }
  if (input.taskKind !== "agent") return { kind: "hidden" };
  if (visit.status === "superseded") {
    return {
      kind: "disabled",
      reason: "A later rerun replaced this visit",
      ...(input.currentVisitHref ? { latestHref: input.currentVisitHref } : {}),
    };
  }
  if (!canRerunVisit(input.execution, visit)) {
    return { kind: "disabled", reason: "This visit can't be rerun" };
  }
  const status = deriveVisitDisplayStatus(visit);
  if (status === "queued" || status === "running") {
    return { kind: "disabled", reason: "Waiting for this step to finish" };
  }
  if (input.isMutating) {
    return {
      kind: "disabled",
      reason: "Waiting for the current action to finish",
    };
  }
  return { kind: "ready" };
}

/**
 * Error handling: `catch`, then failing the lane or the run.
 * Also finishing the run and cancelling open work.
 */
import { contextFor } from "./chain";
import { enterNode } from "./enter";
import { laneFinished } from "./lanes";
import { closeQuestions } from "./questions";
import {
  emit,
  isRunFinished,
  isTaskOpen,
  isVisitOpen,
  latestTaskOf,
  nodeOf,
  type EngineContext,
} from "./state";
import { errorMatches } from "@scarn/core/tasks/task/domain/retry-decision";
import { tryResolveArgs } from "./transitions";
import type { EngineError, RunStatus, Visit } from "./types";

/**
 * Cancels each open visit and its open Task, and marks its open questions
 * not needed; `status` lets reruns supersede instead.
 */
export function closeVisits(
  ctx: EngineContext,
  visits: readonly Visit[],
  status: "cancelled" | "superseded",
): void {
  closeQuestions(ctx, visits);
  for (const visit of visits) {
    const open = isVisitOpen(visit);
    if (open || status === "superseded") {
      emit(ctx, {
        type: "updateVisit",
        visitId: visit.id,
        patch:
          status === "superseded"
            ? { status }
            : { status, completedAt: ctx.options.now },
      });
    }
    const task = latestTaskOf(ctx, visit.id);
    if (open && task !== undefined && isTaskOpen(ctx, task.taskId)) {
      emit(ctx, { type: "cancelTask", taskId: task.taskId });
    }
  }
}

export function finishRun(
  ctx: EngineContext,
  status: Exclude<RunStatus, "active" | "waiting">,
  endNodeId: string | null,
  error: EngineError | null,
  cancelledByUserId: string | null = null,
): void {
  if (isRunFinished(ctx.run)) {
    return;
  }
  closeVisits(ctx, ctx.visits.filter(isVisitOpen), "cancelled");
  for (const lane of ctx.lanes) {
    if (lane.status === "pending" || lane.status === "active") {
      emit(ctx, {
        type: "updateLane",
        laneId: lane.id,
        patch: { status: "cancelled" },
      });
    }
  }
  emit(ctx, {
    type: "updateRun",
    patch: {
      status,
      endNodeId,
      error,
      completedAt: ctx.options.now,
      ...(cancelledByUserId === null ? {} : { cancelledByUserId }),
    },
  });
}

export function failLaneOrRun(
  ctx: EngineContext,
  laneId: string | null,
  error: EngineError,
): void {
  if (laneId === null) {
    finishRun(ctx, "failed", null, error);
  } else {
    laneFinished(ctx, laneId, "failed");
  }
}

/**
 * Handles a named error on an open visit: the first matching `catch`, else
 * fails the lane or run. A step's retries are its Task's (`retryDecision`),
 * so a Task failure only reaches here once the Task has stopped retrying.
 */
export function handleError(
  ctx: EngineContext,
  visit: Visit,
  error: EngineError,
): void {
  emit(ctx, {
    type: "updateVisit",
    visitId: visit.id,
    patch: { status: "failed", error, completedAt: ctx.options.now },
  });
  const node = nodeOf(ctx, visit.nodeId);
  const catches =
    node.kind === "step" || node.kind === "wait" ? (node.catch ?? []) : [];
  const index = catches.findIndex((entry) =>
    errorMatches(entry.on, error.name),
  );
  const entry = catches[index];
  if (entry === undefined) {
    failLaneOrRun(ctx, visit.laneId, error);
    return;
  }
  const args = tryResolveArgs(
    entry.args,
    contextFor(ctx, visit, { error, result: undefined }),
  );
  if (!args.ok) {
    failLaneOrRun(ctx, visit.laneId, args.error);
    return;
  }
  enterNode(ctx, {
    nodeId: entry.to,
    input: args.value,
    laneId: visit.laneId,
    fromVisitId: visit.id,
    fromLaneGroupId: null,
    transition: { kind: "catch", index },
  });
}

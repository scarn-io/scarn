/**
 * Entering a node: creating its visit, checking `maxRuns`, queueing a step's
 * Task, opening a wait (asking its question for a `reply` wait), or finishing
 * a lane or the run at a terminal node.
 */
import type {
  JsonObject,
  StepNode,
} from "@scarn/sdk/contracts/pipeline-document";
import { baseBranchFor } from "./chain";
import { handleError, finishRun } from "./failure";
import { endPath, laneFinished } from "./lanes";
import { buildQuestionBody } from "./questions";
import type { TaskRunReason } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import { emit, nodeOf, type EngineContext } from "./state";
import {
  ENGINE_ERRORS,
  type Routing,
  type RoutingNote,
  type EngineError,
  type Visit,
  type VisitTransition,
} from "./types";

export interface Entry {
  nodeId: string;
  input: JsonObject;
  laneId: string | null;
  fromVisitId: string | null;
  fromLaneGroupId: string | null;
  transition: VisitTransition;
  routing?: Routing | null;
  createdByUserId?: string | null;
  previousTaskId?: string | null;
  message?: string | null;
  /** Set when the args couldn't be resolved: the visit is created and fails with this error. */
  argsError?: EngineError;
}

function maxRunsExceeded(
  ctx: EngineContext,
  entry: Entry,
  maxRuns: number | undefined,
): boolean {
  if (maxRuns === undefined) {
    return false;
  }
  const runs = ctx.visits.filter(
    (visit) =>
      visit.nodeId === entry.nodeId &&
      visit.laneId === entry.laneId &&
      visit.status !== "superseded",
  ).length;
  return runs >= maxRuns;
}

function isVisitOpenKind(kind: Visit["nodeKind"]): boolean {
  return kind === "step" || kind === "wait";
}

export function withNotes(
  routing: Routing | null | undefined,
  notes: RoutingNote[],
): Routing | null {
  if (notes.length === 0) {
    return routing ?? null;
  }
  return { ...(routing ?? {}), notes: [...(routing?.notes ?? []), ...notes] };
}

export function queueTask(
  ctx: EngineContext,
  visit: Visit,
  node: StepNode,
  options: {
    attemptNumber: number;
    reason: TaskRunReason;
    previousTaskId: string | null;
    baseBranch: string | null;
    message?: string | null;
  },
): void {
  emit(ctx, {
    type: "queueTask",
    task: {
      id: ctx.options.newId(),
      taskId: visit.taskId ?? ctx.options.newId(),
      visitId: visit.id,
      attemptNumber: options.attemptNumber,
      reason: options.reason,
      stepKey: node.step,
      input: visit.input,
      previousTaskId: options.previousTaskId,
      baseBranch: options.baseBranch,
      executionTimeoutSeconds: node.timeoutSeconds ?? null,
      heartbeatSeconds: node.heartbeatSeconds ?? null,
      message: options.message ?? null,
    },
  });
}

/** Creates the visit for `entry` and does whatever entering its node means. */
export function enterNode(ctx: EngineContext, entry: Entry): Visit {
  const node = nodeOf(ctx, entry.nodeId);
  const { now } = ctx.options;
  const overLimit =
    (node.kind === "step" || node.kind === "wait") &&
    maxRunsExceeded(ctx, entry, node.maxRuns);
  const branch =
    node.kind === "step" && !overLimit
      ? baseBranchFor(ctx, entry)
      : { branch: null, notes: [] };
  const question =
    node.kind === "wait" &&
    node.for === "reply" &&
    !overLimit &&
    entry.argsError === undefined
      ? buildQuestionBody(entry.input["questions"])
      : null;
  const terminalError: EngineError | null =
    node.kind === "fail"
      ? {
          name: node.error ?? ENGINE_ERRORS.failed,
          message: node.cause ?? `Reached fail node "${entry.nodeId}"`,
        }
      : null;
  const visit: Visit = {
    id: ctx.options.newId(),
    nodeId: entry.nodeId,
    nodeKind: node.kind,
    laneId: entry.laneId,
    fromVisitId: entry.fromVisitId,
    fromLaneGroupId: entry.fromLaneGroupId,
    transition: entry.transition,
    routing: withNotes(entry.routing, [
      ...branch.notes,
      ...(question?.notes ?? []),
    ]),
    status:
      node.kind === "wait"
        ? "waiting"
        : node.kind === "succeed"
          ? "succeeded"
          : node.kind === "fail"
            ? "failed"
            : "active",
    input: entry.input,
    taskId: null,
    resultTaskId: null,
    result: null,
    error: terminalError,
    createdByUserId: entry.createdByUserId ?? null,
    resolvedByUserId: null,
    resolvedAt: null,
    createdAt: now,
    completedAt: node.kind === "succeed" || node.kind === "fail" ? now : null,
    conversationId: null,
  };
  emit(ctx, { type: "createVisit", visit });
  if (entry.argsError !== undefined && isVisitOpenKind(node.kind)) {
    handleError(ctx, visit, entry.argsError);
    return visit;
  }
  if ((node.kind === "step" || node.kind === "wait") && overLimit) {
    handleError(ctx, visit, {
      name: ENGINE_ERRORS.maxRunsExceeded,
      message: `"${entry.nodeId}" has already run ${String(node.maxRuns)} times`,
    });
    return visit;
  }
  if (question !== null) {
    emit(ctx, {
      type: "askQuestion",
      questionId: ctx.options.newId(),
      commentId: ctx.options.newId(),
      visitId: visit.id,
      body: question.body,
    });
    return visit;
  }
  if (node.kind === "step") {
    queueTask(ctx, visit, node, {
      attemptNumber: 1,
      reason: "initial",
      previousTaskId: entry.previousTaskId ?? null,
      baseBranch: branch.branch,
      message: entry.message ?? null,
    });
    return visit;
  }
  if (node.kind === "succeed") {
    endPath(ctx, visit.laneId);
  }
  if (node.kind === "fail" && terminalError !== null) {
    if (visit.laneId === null) {
      finishRun(ctx, "failed", visit.nodeId, terminalError);
    } else {
      laneFinished(ctx, visit.laneId, "failed");
    }
  }
  return visit;
}

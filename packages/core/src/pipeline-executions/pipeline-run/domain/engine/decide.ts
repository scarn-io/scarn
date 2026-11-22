/**
 * `decide(document, runState, event, options) → commands`: the pure pipeline
 * interpreter. It reads an in-memory copy of a run and returns the writes
 * that move it on, in an order that can be applied in one transaction.
 */
import {
  DEFAULT_MAX_TURNS,
  isJsonObject,
  type JsonValue,
  type PipelineDocument,
  type WaitNode,
} from "@scarn/sdk/contracts/pipeline-document";
import { advanceFrom } from "./advance";
import { baseBranchFor, contextFor } from "./chain";
import { enterNode } from "./enter";
import { finishRun, handleError } from "./failure";
import { overruleRoute } from "./overrule";
import { rerunFrom } from "./rerun";
import {
  createContext,
  emit,
  isRunFinished,
  isVisitOpen,
  latestTaskOf,
  nodeOf,
  visitById,
  type EngineContext,
} from "./state";
import { tryResolveArgs } from "./transitions";
import { onTaskResumed, onTaskYielded } from "./yields";
import {
  DecideError,
  ENGINE_ERRORS,
  ignore,
  type DecideOptions,
  type DecideResult,
  type EngineError,
  type EngineEvent,
  type Ignored,
  type RunState,
  type RunStatus,
  type Visit,
} from "./types";

function start(ctx: EngineContext): void {
  if (ctx.visits.length > 0) {
    throw new DecideError("already_started", "the run has already started");
  }
  const { start: transition } = ctx.document;
  const args = tryResolveArgs(transition.args, contextFor(ctx, undefined));
  if (!args.ok) {
    finishRun(ctx, "failed", null, args.error);
    return;
  }
  enterNode(ctx, {
    nodeId: transition.to,
    input: args.value,
    laneId: null,
    fromVisitId: null,
    fromLaneGroupId: null,
    transition: { kind: "start", index: 0 },
  });
}

type TaskLookup = { visit: Visit } | { ignored: Ignored };

/**
 * The visit in `expected` status whose Task is `taskId` and whose latest run
 * is `taskRunId`, or why the event is ignored. A step visit waits in its
 * conversation, so only a person's action on its Task (`task_resumed`, or
 * `task_succeeded` with the Task's own result) is current then.
 */
function visitForTask(
  ctx: EngineContext,
  taskId: string,
  taskRunId: string,
  expected: "active" | "waiting",
): TaskLookup {
  const visit = ctx.visits.find((entry) => entry.taskId === taskId);
  if (visit === undefined) {
    return {
      ignored: ignore(
        "stale",
        `task ${taskId} isn't linked to a visit of this run`,
      ),
    };
  }
  if (visit.status !== expected) {
    return {
      ignored: ignore("stale", `visit ${visit.id} is ${visit.status}`),
    };
  }
  if (latestTaskOf(ctx, visit.id)?.taskId !== taskRunId) {
    return {
      ignored: ignore(
        "stale",
        `task run ${taskRunId} is not the visit's latest attempt`,
      ),
    };
  }
  if (isRunFinished(ctx.run)) {
    return { ignored: ignore("stale", `the run is ${ctx.run.status}`) };
  }
  return { visit };
}

function stringField(
  value: JsonValue | undefined,
  key: string,
): string | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

/** The named error for a failed Task: the reported error, else the Task's stored error, else `Scarn.StepFailed`. */
function taskError(
  ctx: EngineContext,
  taskId: string,
  reported: { name?: string; message?: string; cause?: JsonValue } | undefined,
): EngineError {
  const stored = ctx.tasks.get(taskId)?.error ?? undefined;
  const name =
    reported?.name ?? stringField(stored, "name") ?? ENGINE_ERRORS.stepFailed;
  const message =
    reported?.message ?? stringField(stored, "message") ?? "The step failed";
  const cause =
    reported?.cause ?? (isJsonObject(stored) ? stored["cause"] : undefined);
  return cause === undefined ? { name, message } : { name, message, cause };
}

/** The error a visit fails with when its Task hands over with no turns left. */
function maxTurnsExceeded(ctx: EngineContext, visit: Visit): EngineError {
  const node = nodeOf(ctx, visit.nodeId);
  const maxTurns =
    node.kind === "step" ? (node.maxTurns ?? DEFAULT_MAX_TURNS) : 0;
  return {
    name: ENGINE_ERRORS.maxTurnsExceeded,
    message: `"${visit.nodeId}" can't hand over more than ${String(maxTurns)} times`,
  };
}

type TaskEvent = Extract<
  EngineEvent,
  {
    type:
      | "task_succeeded"
      | "task_failed"
      | "task_waiting"
      | "task_cancelled"
      | "task_resumed";
  }
>;

/** Whether `event` is a person acting on a Task that waits for them. */
const isPersonAction = (event: TaskEvent): boolean =>
  event.type === "task_resumed" ||
  (event.type === "task_succeeded" && event.result !== undefined);

/**
 * A visit's Task changed. A cancelled Task is ignored: the engine cancels
 * Tasks itself, after it has already moved the visit on.
 */
function onTaskEvent(ctx: EngineContext, event: TaskEvent): Ignored | null {
  const lookup = visitForTask(
    ctx,
    event.taskId,
    event.taskRunId,
    isPersonAction(event) ? "waiting" : "active",
  );
  if ("ignored" in lookup) {
    return lookup.ignored;
  }
  const { visit } = lookup;
  switch (event.type) {
    case "task_waiting":
      onTaskYielded(ctx, visit, event);
      return null;
    case "task_resumed":
      onTaskResumed(ctx, visit);
      return null;
    case "task_succeeded":
      emit(ctx, {
        type: "updateVisit",
        visitId: visit.id,
        patch: {
          status: "succeeded",
          ...(event.result === undefined
            ? { resultTaskId: event.taskRunId }
            : { result: event.result }),
          completedAt: ctx.options.now,
        },
      });
      advanceFrom(ctx, visit);
      return null;
    case "task_failed": {
      const error = taskError(ctx, event.taskRunId, event.error);
      handleError(
        ctx,
        visit,
        error.name === ENGINE_ERRORS.maxTurnsExceeded
          ? maxTurnsExceeded(ctx, visit)
          : error,
      );
      return null;
    }
    case "task_cancelled":
      return ignore("stale", `task ${event.taskId} was cancelled`);
  }
}

/**
 * A step visit's Task was never created (its concurrency group was full):
 * the visit fails with the error, which its `catch` can take.
 */
function onTaskDropped(
  ctx: EngineContext,
  event: Extract<EngineEvent, { type: "task_dropped" }>,
): Ignored | null {
  const visit = visitById(ctx, event.visitId);
  if (visit.status !== "active" || isRunFinished(ctx.run)) {
    return ignore("stale", `visit ${visit.id} is ${visit.status}`);
  }
  handleError(ctx, visit, event.error);
  return null;
}

/** The waiting wait visit `visitId` names, or why the event is ignored. */
function waitingWaitVisit(
  ctx: EngineContext,
  visitId: string,
): { visit: Visit; node: WaitNode } | { ignored: Ignored } {
  const visit = ctx.visits.find((entry) => entry.id === visitId);
  if (visit === undefined) {
    throw new DecideError(
      "unknown_visit",
      `visit ${visitId} is not in this run`,
    );
  }
  if (visit.status !== "waiting" || isRunFinished(ctx.run)) {
    return {
      ignored: ignore("not_waiting", `visit ${visit.id} is ${visit.status}`),
    };
  }
  const node = nodeOf(ctx, visit.nodeId);
  if (node.kind !== "wait") {
    return {
      ignored: ignore("not_waiting", `visit ${visit.id} isn't a wait`),
    };
  }
  return { visit, node };
}

/**
 * Records a decision on a waiting decision visit: the visit succeeds with
 * `{ action, body }` and the run follows its `next`. An action the node
 * doesn't list, or a missing body the action requires, is ignored as
 * `invalid_decision`.
 */
function onDecisionMade(
  ctx: EngineContext,
  event: Extract<EngineEvent, { type: "decision_made" }>,
): Ignored | null {
  const lookup = waitingWaitVisit(ctx, event.visitId);
  if ("ignored" in lookup) {
    return lookup.ignored;
  }
  const { visit, node } = lookup;
  if (node.for !== "decision") {
    return ignore(
      "not_waiting",
      `visit ${visit.id} isn't waiting for a decision`,
    );
  }
  const action = node.actions?.find((entry) => entry.key === event.action);
  if (action === undefined) {
    return ignore("invalid_decision", `unknown action "${event.action}"`);
  }
  if (action.body === "required" && event.body === null) {
    return ignore("invalid_decision", `action "${action.key}" needs a body`);
  }
  const { now } = ctx.options;
  emit(ctx, {
    type: "updateVisit",
    visitId: visit.id,
    patch: {
      status: "succeeded",
      result: { action: action.key, body: event.body },
      resolvedByUserId: event.userId,
      resolvedAt: now,
      completedAt: now,
    },
  });
  advanceFrom(ctx, visit);
  return null;
}

/** Answers a wait visit's open question: the visit resolves with `{ replied, body, commentId }`. */
function onQuestionAnswered(
  ctx: EngineContext,
  event: Extract<EngineEvent, { type: "question_answered" }>,
): Ignored | null {
  const question = ctx.questions.find((entry) => entry.id === event.questionId);
  if (question === undefined) {
    return ignore(
      "not_waiting",
      `question ${event.questionId} isn't in this run`,
    );
  }
  if (question.status !== "open") {
    return ignore(
      "not_waiting",
      `question ${question.id} is ${question.status}`,
    );
  }
  const visit = visitById(ctx, question.visitId);
  if (visit.nodeKind !== "wait") {
    return ignore("not_waiting", `visit ${visit.id} isn't a wait`);
  }
  if (visit.status !== "waiting" || isRunFinished(ctx.run)) {
    return ignore("not_waiting", `visit ${visit.id} is ${visit.status}`);
  }
  const { now } = ctx.options;
  emit(ctx, {
    type: "updateQuestion",
    questionId: question.id,
    patch: {
      status: "answered",
      answerCommentId: event.answer?.commentId ?? null,
      answeredByUserId: event.userId,
      resolvedAt: now,
    },
  });
  emit(ctx, {
    type: "updateVisit",
    visitId: visit.id,
    patch: {
      status: "succeeded",
      result: {
        replied: event.answer !== null,
        body: event.answer?.body ?? null,
        commentId: event.answer?.commentId ?? null,
      },
      resolvedByUserId: event.userId,
      resolvedAt: now,
      completedAt: now,
    },
  });
  advanceFrom(ctx, visit);
  return null;
}

/** active / waiting from the open visits; terminal statuses are set by `finishRun`. */
function settleRunStatus(ctx: EngineContext): void {
  if (isRunFinished(ctx.run)) {
    return;
  }
  const open = ctx.visits.filter(isVisitOpen);
  const waiting =
    open.some((visit) => visit.status === "waiting") &&
    !open.some((visit) => visit.status === "active");
  const status: RunStatus = waiting ? "waiting" : "active";
  if (ctx.run.status !== status) {
    emit(ctx, { type: "updateRun", patch: { status } });
  }
}

/**
 * The base branch `visitId`'s Task starts from, as when it was entered: the
 * nearest upstream work branch, or null. A Task that waited for a
 * concurrency slot was created with no run, so its first run asks here.
 */
export function visitBaseBranch(
  document: PipelineDocument,
  state: RunState,
  visitId: string,
): string | null {
  const ctx = createContext(document, state, {
    newId: () => {
      throw new Error("visitBaseBranch writes nothing");
    },
    now: new Date(0).toISOString(),
  });
  return baseBranchFor(ctx, visitById(ctx, visitId)).branch;
}

export function decide(
  document: PipelineDocument,
  state: RunState,
  event: EngineEvent,
  options: DecideOptions,
): DecideResult {
  const ctx = createContext(document, state, options);
  let ignored: Ignored | null = null;
  switch (event.type) {
    case "start":
      start(ctx);
      break;
    case "task_succeeded":
    case "task_failed":
    case "task_waiting":
    case "task_cancelled":
    case "task_resumed":
      ignored = onTaskEvent(ctx, event);
      break;
    case "task_dropped":
      ignored = onTaskDropped(ctx, event);
      break;
    case "decision_made":
      ignored = onDecisionMade(ctx, event);
      break;
    case "question_answered":
      ignored = onQuestionAnswered(ctx, event);
      break;
    case "rerun_from":
      rerunFrom(ctx, event.visitId, event.userId, event.message);
      break;
    case "route_overruled":
      overruleRoute(ctx, event);
      break;
    case "cancel":
      if (isRunFinished(ctx.run)) {
        ignored = ignore("stale", `the run is ${ctx.run.status}`);
        break;
      }
      finishRun(ctx, "cancelled", null, null, event.userId);
      break;
  }
  settleRunStatus(ctx);
  return ignored === null
    ? { commands: ctx.commands }
    : { commands: ctx.commands, ignored };
}

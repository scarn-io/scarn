/**
 * Reruns: supersede a visit and everything after it, reopen any lane groups
 * whose merge is superseded (clearing the arrivals of the lanes being rerun),
 * and create a fresh visit with re-resolved args. A merge visit is rerun
 * with its lanes' stored arrival args, recombined. A continuation lane whose
 * partial merge is superseded is cancelled; the merge creates a new one when
 * it fires again.
 */
import type {
  Catch,
  Otherwise,
  Route,
} from "@scarn/sdk/contracts/pipeline-document";
import {
  contextFor,
  descendantsOf,
  enclosingGroups,
  predecessorOf,
} from "./chain";
import { enterNode, type Entry } from "./enter";
import { closeVisits } from "./failure";
import {
  cancelNestedLanes,
  laneArgs,
  NO_ARRIVAL,
  spawningTransition,
} from "./lanes";
import { combineArrivals, markMerged, splitOf } from "./merges";
import {
  emit,
  groupById,
  laneById,
  latestTaskOf,
  nodeOf,
  visitById,
  type EngineContext,
} from "./state";
import { routeFor, tryResolveArgs } from "./transitions";
import { DecideError, type EngineError, type Visit } from "./types";

function transitionInto(
  ctx: EngineContext,
  target: Visit,
): Route | Otherwise | Catch | undefined {
  const { kind, index } = target.transition;
  if (kind === "start") {
    return ctx.document.start;
  }
  if (kind === "merge") {
    return undefined;
  }
  const from = visitById(ctx, target.fromVisitId as string);
  const node = nodeOf(ctx, from.nodeId);
  if (kind === "catch") {
    return node.kind === "step" || node.kind === "wait"
      ? node.catch?.[index]
      : undefined;
  }
  return routeFor(node, target.transition);
}

function resolveRerunArgs(
  ctx: EngineContext,
  target: Visit,
): { input: Entry["input"]; argsError?: EngineError } {
  if (target.transition.kind === "merge") {
    const group = groupById(ctx, target.fromLaneGroupId as string);
    return { input: combineArrivals(ctx, group, target.nodeId) };
  }
  const transition = transitionInto(ctx, target);
  if (transition === undefined) {
    return { input: {} };
  }
  const previous = predecessorOf(ctx, target);
  if (
    (target.transition.kind === "route" ||
      target.transition.kind === "otherwise") &&
    previous !== undefined &&
    previous.laneId !== target.laneId &&
    target.laneId !== null
  ) {
    const lane = laneById(ctx, target.laneId);
    const { spawner } = spawningTransition(ctx, lane);
    const outcome = laneArgs(ctx, spawner, transition, lane.item);
    return outcome.ok
      ? { input: outcome.value }
      : { input: {}, argsError: outcome.error };
  }
  const outcome = tryResolveArgs(
    transition.args,
    contextFor(
      ctx,
      previous,
      target.transition.kind === "catch"
        ? { error: previous?.error ?? undefined, result: undefined }
        : {},
    ),
  );
  return outcome.ok
    ? { input: outcome.value }
    : { input: {}, argsError: outcome.error };
}

/**
 * Reopens the groups enclosing each superseded visit: its lane (and each
 * enclosing lane) goes back to active with its arrival cleared, and a merged
 * group goes back to open unless the lane can't reach the group's merge (a
 * fire-and-forget lane), which leaves the merge in place.
 */
export function reopenGroups(
  ctx: EngineContext,
  affected: readonly Visit[],
): void {
  const affectedIds = new Set(affected.map((visit) => visit.id));
  for (const visit of affected) {
    for (const { laneId, groupId } of enclosingGroups(ctx, visit.laneId)) {
      const group = groupById(ctx, groupId);
      const lane = laneById(ctx, laneId);
      if (
        lane.status === "cancelled" ||
        group.status === "failed" ||
        affectedIds.has(group.spawnedByVisitId)
      ) {
        break;
      }
      const mergeNodeId = splitOf(ctx, group)?.merge ?? null;
      const reopens =
        mergeNodeId === null ||
        lane.status === "arrived" ||
        ctx.splits.reachable(visit.nodeId).has(mergeNodeId);
      if (lane.status !== "active") {
        emit(ctx, {
          type: "updateLane",
          laneId,
          patch: { status: "active", ...NO_ARRIVAL },
        });
      }
      if (!reopens) {
        break;
      }
      if (group.status === "merged") {
        emit(ctx, {
          type: "updateLaneGroup",
          groupId,
          patch: { status: "open" },
        });
      }
    }
  }
}

/** Cancels the continuation lanes of the superseded partial merge visits, except `root`'s. */
export function cancelContinuations(
  ctx: EngineContext,
  superseded: readonly Visit[],
  root: Visit,
): void {
  for (const visit of superseded) {
    if (
      visit.id === root.id ||
      visit.transition.kind !== "merge" ||
      visit.laneId === null
    ) {
      continue;
    }
    const lane = laneById(ctx, visit.laneId);
    if (lane.origin === "merge" && lane.laneGroupId === visit.fromLaneGroupId) {
      emit(ctx, {
        type: "updateLane",
        laneId: lane.id,
        patch: { status: "cancelled" },
      });
    }
  }
}

/** Puts a finished (succeeded or failed) run back to `active`. */
export function reopenRun(ctx: EngineContext): void {
  if (ctx.run.status === "succeeded" || ctx.run.status === "failed") {
    emit(ctx, {
      type: "updateRun",
      patch: {
        status: "active",
        endNodeId: null,
        error: null,
        completedAt: null,
        cancelledByUserId: null,
      },
    });
  }
}

/**
 * Supersedes every visit after `root` (and `root` itself when `includeRoot`),
 * cancels the lanes of the groups they spawned and the continuation lanes of
 * their partial merges, reopens the groups they were in, and reopens a
 * finished run. A kept root is treated like a superseded one (the groups it
 * spawned are cancelled, its lane is reopened so it can move on again) except
 * that it stays open and its own continuation lane is kept. Returns the
 * superseded visits.
 */
export function supersedeAfter(
  ctx: EngineContext,
  root: Visit,
  { includeRoot }: { includeRoot: boolean },
): Visit[] {
  const affected = descendantsOf(ctx, root);
  const superseded = includeRoot
    ? affected
    : affected.filter((visit) => visit.id !== root.id);
  closeVisits(ctx, superseded, "superseded");
  cancelNestedLanes(ctx, affected);
  cancelContinuations(ctx, superseded, root);
  reopenGroups(ctx, affected);
  reopenRun(ctx);
  return superseded;
}

/** Supersedes `visitId` and every visit after it, then creates the replacement visit. */
export function rerunFrom(
  ctx: EngineContext,
  visitId: string,
  userId: string,
  message: string | undefined,
): void {
  const target = ctx.visits.find((visit) => visit.id === visitId);
  if (target === undefined) {
    throw new DecideError(
      "unknown_visit",
      `visit ${visitId} is not in this run`,
    );
  }
  if (ctx.run.status === "cancelled") {
    throw new DecideError("run_not_active", "a cancelled run can't be rerun");
  }
  if (target.status === "superseded") {
    throw new DecideError(
      "invalid_visit_state",
      `visit ${visitId} was already superseded`,
    );
  }
  if (target.nodeKind !== "step" && target.nodeKind !== "wait") {
    throw new DecideError(
      "invalid_visit_state",
      `only step and wait visits can be rerun, not "${target.nodeKind}"`,
    );
  }
  if (message !== undefined && target.nodeKind !== "step") {
    throw new DecideError(
      "invalid_visit_state",
      "messages can only be sent to step visits",
    );
  }
  if (target.laneId !== null) {
    const group = groupById(ctx, laneById(ctx, target.laneId).laneGroupId);
    if (group.status === "failed") {
      throw new DecideError(
        "invalid_visit_state",
        `visit ${visitId} is in a lane group that failed`,
      );
    }
  }
  const previousTaskId = latestTaskOf(ctx, target.id)?.taskId ?? null;
  supersedeAfter(ctx, target, { includeRoot: true });
  const { input, argsError } = resolveRerunArgs(ctx, target);
  const visit = enterNode(ctx, {
    nodeId: target.nodeId,
    input,
    laneId: target.laneId,
    fromVisitId: target.fromVisitId,
    fromLaneGroupId: target.fromLaneGroupId,
    transition: target.transition,
    createdByUserId: userId,
    previousTaskId,
    message: message ?? null,
    ...(argsError === undefined ? {} : { argsError }),
  });
  if (target.fromLaneGroupId !== null) {
    markMerged(ctx, target.fromLaneGroupId, target.nodeId, visit.id);
  }
}

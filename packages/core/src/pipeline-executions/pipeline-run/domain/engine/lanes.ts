/**
 * Lanes: spawning a group for a split (an `each` route or a `match: "all"`
 * node), starting pending lanes up to `maxConcurrency`, failing a group past
 * its tolerated failures, recording lanes arriving at a merge with a
 * `partial` route, and finishing the run once the top-level path has ended
 * and no lane is still running.
 */
import type {
  JsonObject,
  JsonValue,
  Otherwise,
  Route,
} from "@scarn/sdk/contracts/pipeline-document";
import { contextFor, descendantsOf, enclosingGroups } from "./chain";
import { enterNode } from "./enter";
import { closeVisits, failLaneOrRun, finishRun } from "./failure";
import { checkMerge } from "./merges";
import {
  emit,
  groupById,
  isRunFinished,
  isVisitOpen,
  laneById,
  lanesOf,
  nodeOf,
  visitById,
  type EngineContext,
} from "./state";
import {
  exceedsTolerance,
  routeFor,
  tryResolveArgs,
  tryResolveArgsReporting,
  tryResolveItems,
  type Outcome,
  type ReportingOutcome,
} from "./transitions";
import {
  ENGINE_ERRORS,
  type Lane,
  type LaneGroup,
  type Visit,
  type VisitTransition,
} from "./types";

/** Ends a path: ends the lane, or at the top level finishes the run once no lane is still running. */
export function endPath(ctx: EngineContext, laneId: string | null): void {
  if (laneId === null) {
    settleRun(ctx);
  } else {
    laneFinished(ctx, laneId, "ended");
  }
}

/**
 * The node where the top-level path ended: its latest visit, or null when
 * that visit spawned lanes that never merged back (the path ended in a lane).
 */
function topLevelEnd(ctx: EngineContext): string | null {
  const last = ctx.visits
    .filter((visit) => visit.laneId === null && visit.status !== "superseded")
    .at(-1);
  if (
    last === undefined ||
    ctx.groups.some(
      (group) => group.spawnedByVisitId === last.id && group.laneCount > 0,
    )
  ) {
    return null;
  }
  return last.nodeId;
}

/** Whether a group can still move on: its spawner wasn't superseded and no lane enclosing it was cancelled. */
function isGroupLive(ctx: EngineContext, group: LaneGroup): boolean {
  return (
    visitById(ctx, group.spawnedByVisitId).status !== "superseded" &&
    enclosingGroups(ctx, group.parentLaneId).every(
      ({ laneId }) => laneById(ctx, laneId).status !== "cancelled",
    )
  );
}

/** Finishes the run as succeeded when nothing is left to run: no open visit, no running lane and no open group. */
export function settleRun(ctx: EngineContext): void {
  if (
    isRunFinished(ctx.run) ||
    ctx.visits.some(isVisitOpen) ||
    ctx.groups.some(
      (group) => group.status === "open" && isGroupLive(ctx, group),
    ) ||
    ctx.lanes.some(
      (lane) => lane.status === "pending" || lane.status === "active",
    )
  ) {
    return;
  }
  finishRun(ctx, "succeeded", topLevelEnd(ctx), null);
}

/** The route that started a split lane, resolved against the visit that spawned its group. */
export function spawningTransition(
  ctx: EngineContext,
  lane: Lane,
): { transition: Route | Otherwise; spawner: Visit } {
  const group = groupById(ctx, lane.laneGroupId);
  const spawner = visitById(ctx, group.spawnedByVisitId);
  const transition = routeFor(nodeOf(ctx, spawner.nodeId), lane.route);
  if (transition === undefined) {
    throw new Error(`lane ${lane.id} has no spawning route`);
  }
  return { transition, spawner };
}

/** Resolves a lane's first-visit args from the spawning visit and the lane's item. */
export function laneArgs(
  ctx: EngineContext,
  spawner: Visit,
  transition: Route | Otherwise,
  item: JsonValue | null,
): Outcome<JsonObject> {
  return tryResolveArgs(
    transition.args,
    contextFor(ctx, spawner, item === null ? {} : { item }),
  );
}

/** {@link laneArgs}, also reporting the args whose reference resolved to nothing. */
export function laneArgsReporting(
  ctx: EngineContext,
  spawner: Visit,
  transition: Route | Otherwise,
  item: JsonValue | null,
): ReportingOutcome<JsonObject> {
  return tryResolveArgsReporting(
    transition.args,
    contextFor(ctx, spawner, item === null ? {} : { item }),
  );
}

/** A lane's arrival fields, cleared. */
export const NO_ARRIVAL = {
  arrivedAtNodeId: null,
  arrivalArgs: null,
  arrivedFromVisitId: null,
  arrivalTransition: null,
  mergedIntoVisitId: null,
} as const;

/** Starts a lane: enters its route's node, or spawns the item lanes of an `each` route in an `all` group. */
export function startLane(
  ctx: EngineContext,
  group: LaneGroup,
  lane: Lane,
): void {
  const { transition, spawner } = spawningTransition(ctx, lane);
  if (lane.status !== "active") {
    emit(ctx, {
      type: "updateLane",
      laneId: lane.id,
      patch: { status: "active" },
    });
  }
  if (group.kind === "all" && transition.each !== undefined) {
    const items = tryResolveItems(
      transition.each.over,
      contextFor(ctx, spawner),
    );
    if (!items.ok) {
      laneFinished(ctx, lane.id, "failed");
      return;
    }
    spawnSplit(ctx, spawner, {
      kind: "each",
      route: lane.route,
      items: items.value,
      parentLaneId: lane.id,
    });
    return;
  }
  const args = laneArgs(ctx, spawner, transition, lane.item);
  enterNode(ctx, {
    nodeId: transition.to,
    input: args.ok ? args.value : {},
    laneId: lane.id,
    fromVisitId: spawner.id,
    fromLaneGroupId: null,
    transition: lane.route,
    ...(args.ok ? {} : { argsError: args.error }),
  });
}

export type SplitSpawn =
  | {
      kind: "each";
      route: VisitTransition;
      items: JsonValue[];
      parentLaneId: string | null;
    }
  | { kind: "all"; routes: VisitTransition[] };

/**
 * Creates a group and its lanes and starts the first lanes: one lane per
 * item for an `each` route, or one per taken route for a `match: "all"` node.
 * A group with no lanes is complete straight away.
 */
export function spawnSplit(
  ctx: EngineContext,
  spawner: Visit,
  spawn: SplitSpawn,
): void {
  const each =
    spawn.kind === "each"
      ? routeFor(nodeOf(ctx, spawner.nodeId), spawn.route)?.each
      : undefined;
  const maxConcurrency = each?.maxConcurrency ?? null;
  const entries =
    spawn.kind === "each"
      ? spawn.items.map((item) => ({ route: spawn.route, item }))
      : spawn.routes.map((route) => ({ route, item: null }));
  const group: LaneGroup = {
    id: ctx.options.newId(),
    kind: spawn.kind,
    parentLaneId: spawn.kind === "each" ? spawn.parentLaneId : spawner.laneId,
    spawnedByVisitId: spawner.id,
    laneCount: entries.length,
    maxConcurrency,
    toleratedFailures: each?.toleratedFailures ?? { count: 0 },
    status: "open",
  };
  const lanes: Lane[] = entries.map(({ route, item }, index) => ({
    id: ctx.options.newId(),
    laneGroupId: group.id,
    index,
    item,
    route,
    origin: "split",
    status:
      maxConcurrency === null || index < maxConcurrency ? "active" : "pending",
    ...NO_ARRIVAL,
  }));
  emit(ctx, { type: "createLaneGroup", group, lanes });
  for (const lane of lanes.filter((entry) => entry.status === "active")) {
    if (groupById(ctx, group.id).status !== "open") {
      break;
    }
    startLane(ctx, groupById(ctx, group.id), laneById(ctx, lane.id));
  }
  checkMerge(ctx, group.id);
}

/** Starts the lowest-indexed pending lanes while there is room under `maxConcurrency`. */
export function fillLanes(ctx: EngineContext, groupId: string): void {
  for (;;) {
    const group = groupById(ctx, groupId);
    if (group.status !== "open") {
      return;
    }
    const lanes = lanesOf(ctx, groupId);
    const active = lanes.filter((lane) => lane.status === "active").length;
    const pending = lanes.find((lane) => lane.status === "pending");
    if (
      pending === undefined ||
      (group.maxConcurrency !== null && active >= group.maxConcurrency)
    ) {
      return;
    }
    startLane(ctx, group, pending);
  }
}

function failGroup(ctx: EngineContext, group: LaneGroup): void {
  emit(ctx, {
    type: "updateLaneGroup",
    groupId: group.id,
    patch: { status: "failed" },
  });
  for (const lane of lanesOf(ctx, group.id)) {
    if (lane.status !== "pending" && lane.status !== "active") {
      continue;
    }
    const laneVisits = ctx.visits.filter(
      (visit) => visit.laneId === lane.id && visit.status !== "superseded",
    );
    const affected = laneVisits.flatMap((visit) => descendantsOf(ctx, visit));
    closeVisits(ctx, affected, "cancelled");
    cancelNestedLanes(ctx, affected);
    emit(ctx, {
      type: "updateLane",
      laneId: lane.id,
      patch: { status: "cancelled" },
    });
  }
  const failed = lanesOf(ctx, group.id).filter(
    (lane) => lane.status === "failed",
  ).length;
  failLaneOrRun(ctx, group.parentLaneId, {
    name: ENGINE_ERRORS.lanesFailed,
    message: `${String(failed)} of ${String(group.laneCount)} lanes failed`,
  });
}

/** Cancels the pending and active lanes of groups spawned by any of `visits`. */
export function cancelNestedLanes(
  ctx: EngineContext,
  visits: readonly Visit[],
): void {
  const ids = new Set(visits.map((visit) => visit.id));
  for (const group of ctx.groups) {
    if (!ids.has(group.spawnedByVisitId)) {
      continue;
    }
    for (const lane of lanesOf(ctx, group.id)) {
      if (lane.status === "pending" || lane.status === "active") {
        emit(ctx, {
          type: "updateLane",
          laneId: lane.id,
          patch: { status: "cancelled" },
        });
      }
    }
  }
}

/**
 * Records a lane ending (at `succeed` or a path end) or failing, then moves
 * its group on. A lane that outlives its group's merge still fails the group
 * past its tolerated failures, and its end may finish the run.
 */
export function laneFinished(
  ctx: EngineContext,
  laneId: string,
  status: "ended" | "failed",
): void {
  const lane = laneById(ctx, laneId);
  if (lane.status !== "active") {
    return;
  }
  emit(ctx, { type: "updateLane", laneId, patch: { status } });
  const group = groupById(ctx, lane.laneGroupId);
  if (group.status === "failed") {
    return;
  }
  if (status === "failed") {
    const failed = lanesOf(ctx, group.id).filter(
      (entry) => entry.status === "failed",
    ).length;
    if (exceedsTolerance(group.toleratedFailures, failed, group.laneCount)) {
      failGroup(ctx, group);
      return;
    }
  }
  fillLanes(ctx, group.id);
  checkMerge(ctx, group.id);
  settleRun(ctx);
}

/**
 * Records a lane arriving at its merge with the args its `partial` route
 * supplied. `fromVisitId` is null when a nested merge carried the lane there.
 */
export function arriveAtMerge(
  ctx: EngineContext,
  laneId: string,
  mergeNodeId: string,
  args: JsonObject,
  fromVisitId: string | null,
  transition: VisitTransition | null,
): void {
  const lane = laneById(ctx, laneId);
  const group = groupById(ctx, lane.laneGroupId);
  if (lane.status !== "active" || group.status !== "open") {
    return;
  }
  emit(ctx, {
    type: "updateLane",
    laneId,
    patch: {
      status: "arrived",
      arrivedAtNodeId: mergeNodeId,
      arrivalArgs: args,
      arrivedFromVisitId: fromVisitId,
      arrivalTransition: transition,
      mergedIntoVisitId: null,
    },
  });
  fillLanes(ctx, group.id);
  checkMerge(ctx, group.id);
}

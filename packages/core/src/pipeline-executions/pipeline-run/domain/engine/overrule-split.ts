/**
 * Overrules on a `match: "all"` node: the event carries the full new set of
 * routes, and the lanes of the group the visit spawned are added and removed
 * to match it. Lanes whose route didn't change keep running and keep their
 * results. A removed lane is cancelled and its visits superseded; an added
 * lane joins the group and starts. A merge whose input changes (a removed
 * lane went into it, or an added lane can reach it) is superseded with
 * everything after it, and fires again once its lanes are ready.
 */
import type { Next } from "@scarn/sdk/contracts/pipeline-document";
import { contextFor, descendantsOf, enclosingGroups } from "./chain";
import { closeVisits } from "./failure";
import { cancelNestedLanes, NO_ARRIVAL, settleRun, startLane } from "./lanes";
import { checkMerge, splitOf } from "./merges";
import {
  checkMissingArgs,
  checkOverridable,
  describeRoute,
  missingArgsOf,
  recordOverrule,
  sameRoute,
  type OverruleEvent,
} from "./overrule-checks";
import { cancelContinuations, reopenGroups, reopenRun } from "./rerun";
import {
  emit,
  groupById,
  laneById,
  lanesOf,
  nodeOf,
  type EngineContext,
} from "./state";
import { routeFor } from "./transitions";
import {
  DecideError,
  type Lane,
  type LaneGroup,
  type LaneGroupPatch,
  type Visit,
  type VisitTransition,
} from "./types";

function spawnedGroup(ctx: EngineContext, visit: Visit): LaneGroup {
  const group = ctx.groups.find(
    (candidate) =>
      candidate.kind === "all" && candidate.spawnedByVisitId === visit.id,
  );
  if (group === undefined) {
    throw new DecideError(
      "invalid_visit_state",
      `visit ${visit.id} spawned no lanes`,
    );
  }
  if (group.status === "failed") {
    throw new DecideError(
      "invalid_visit_state",
      `the lanes visit ${visit.id} spawned failed`,
    );
  }
  return group;
}

/** Refuses a set that leaves out a route without `when`, or whose `otherwise` disagrees with the rest. */
function checkRouteSet(
  next: Next,
  nodeId: string,
  routes: readonly VisitTransition[],
): void {
  const has = (entry: VisitTransition) =>
    routes.some((other) => sameRoute(entry, other));
  const duplicated = routes.filter(
    (entry, index) =>
      routes.findIndex((other) => sameRoute(entry, other)) !== index,
  );
  if (duplicated.length > 0) {
    throw new DecideError(
      "route_set_invalid",
      `${duplicated.map(describeRoute).join(", ")} is listed more than once`,
    );
  }
  const unconditional = next.routes.flatMap((route, index) =>
    route.when === undefined ? [{ kind: "route" as const, index }] : [],
  );
  const left = unconditional.filter((entry) => !has(entry));
  if (left.length > 0) {
    throw new DecideError(
      "route_set_invalid",
      `${left.map(describeRoute).join(", ")} has no condition on node "${nodeId}", so it is always taken`,
    );
  }
  if (next.otherwise === undefined) {
    return;
  }
  const conditionTaken = next.routes.some(
    (route, index) => route.when !== undefined && has({ kind: "route", index }),
  );
  if (has({ kind: "otherwise", index: 0 }) === conditionTaken) {
    throw new DecideError(
      "route_set_invalid",
      conditionTaken
        ? "otherwise can't be taken alongside a route with a condition"
        : "otherwise must be taken when no route with a condition is",
    );
  }
}

/** Lanes inside `lane`: the lane itself and the lanes of the groups nested in it. */
function isWithinLane(ctx: EngineContext, laneId: string | null, lane: Lane) {
  return enclosingGroups(ctx, laneId).some((entry) => entry.laneId === lane.id);
}

/**
 * The merge visits whose input the overrule changes: of the group, of the
 * groups nested in it, or of the groups enclosing the visit, either a removed
 * lane's arrival went into them or an added route can reach them.
 */
function staleMerges(
  ctx: EngineContext,
  visit: Visit,
  group: LaneGroup,
  removed: readonly Lane[],
  added: readonly VisitTransition[],
): Visit[] {
  const groupIds = new Set([
    ...ctx.groups
      .filter((candidate) =>
        enclosingGroups(ctx, candidate.parentLaneId).some(
          (entry) => entry.groupId === group.id,
        ),
      )
      .map((candidate) => candidate.id),
    group.id,
    ...enclosingGroups(ctx, visit.laneId).map((entry) => entry.groupId),
  ]);
  const node = nodeOf(ctx, visit.nodeId);
  const targets = added.flatMap((entry) => {
    const route = routeFor(node, entry);
    return route === undefined ? [] : [route.to];
  });
  return ctx.visits.filter(
    (merge) =>
      merge.status !== "superseded" &&
      merge.transition.kind === "merge" &&
      merge.fromLaneGroupId !== null &&
      groupIds.has(merge.fromLaneGroupId) &&
      (ctx.lanes.some(
        (lane) =>
          lane.mergedIntoVisitId === merge.id &&
          removed.some((entry) => isWithinLane(ctx, lane.id, entry)),
      ) ||
        targets.some(
          (to) =>
            to === merge.nodeId || ctx.splits.reachable(to).has(merge.nodeId),
        )),
  );
}

/** Cancels each removed lane and every lane nested in it. */
function cancelRemoved(ctx: EngineContext, removed: readonly Lane[]): void {
  for (const lane of ctx.lanes) {
    if (
      lane.status !== "cancelled" &&
      removed.some((entry) => isWithinLane(ctx, lane.id, entry))
    ) {
      emit(ctx, {
        type: "updateLane",
        laneId: lane.id,
        patch: { status: "cancelled" },
      });
    }
  }
}

function addLanes(
  ctx: EngineContext,
  group: LaneGroup,
  added: readonly VisitTransition[],
): Lane[] {
  const first =
    Math.max(
      group.laneCount - 1,
      ...lanesOf(ctx, group.id).map((lane) => lane.index),
    ) + 1;
  return added.map((route, offset) => {
    const lane: Lane = {
      id: ctx.options.newId(),
      laneGroupId: group.id,
      index: first + offset,
      item: null,
      route,
      origin: "split",
      status: "active",
      ...NO_ARRIVAL,
    };
    emit(ctx, { type: "createLane", lane });
    return lane;
  });
}

/** Applies an overrule of the routes a `match: "all"` visit took to the lanes of the group it spawned. */
export function overruleSplit(
  ctx: EngineContext,
  visit: Visit,
  next: Next,
  event: OverruleEvent,
): void {
  const group = spawnedGroup(ctx, visit);
  checkRouteSet(next, visit.nodeId, event.routes);
  const from = visit.routing?.taken ?? [];
  const added = event.routes.filter(
    (entry) => !from.some((other) => sameRoute(entry, other)),
  );
  const removedRoutes = from.filter(
    (entry) => !event.routes.some((other) => sameRoute(entry, other)),
  );
  checkOverridable(next, [...added, ...removedRoutes]);
  const missing = missingArgsOf(ctx, visit, added, contextFor(ctx, visit));
  checkMissingArgs(missing, event.missingArgs);

  const removed = removedRoutes.flatMap((entry) => {
    const lane = lanesOf(ctx, group.id)
      .filter(
        (candidate) =>
          candidate.origin === "split" && sameRoute(entry, candidate.route),
      )
      .at(-1);
    return lane === undefined ? [] : [lane];
  });
  const stale = staleMerges(ctx, visit, group, removed, added);
  const superseded = new Map<string, Visit>();
  const roots = [
    ...stale,
    ...ctx.visits.filter(
      (candidate) =>
        candidate.status !== "superseded" &&
        removed.some((lane) => isWithinLane(ctx, candidate.laneId, lane)),
    ),
  ];
  for (const root of roots) {
    for (const entry of descendantsOf(ctx, root)) {
      superseded.set(entry.id, entry);
    }
  }
  const affected = [...superseded.values()];
  closeVisits(ctx, affected, "superseded");
  cancelNestedLanes(ctx, affected);
  cancelContinuations(ctx, affected, visit);
  cancelRemoved(ctx, removed);
  reopenGroups(ctx, affected);

  const mergeNodeId = splitOf(ctx, group)?.merge ?? null;
  const remerges =
    group.status === "merged" &&
    (mergeNodeId === null
      ? added.length > 0
      : affected.some(
          (entry) =>
            entry.transition.kind === "merge" && entry.nodeId === mergeNodeId,
        ));
  if (remerges) {
    reopenGroups(ctx, [visit]);
  }
  const laneCount = group.laneCount - removed.length + added.length;
  const lanes = addLanes(ctx, group, added);
  const patch: LaneGroupPatch = {
    ...(remerges ? { status: "open" } : {}),
    ...(laneCount === group.laneCount ? {} : { laneCount }),
  };
  if (Object.keys(patch).length > 0) {
    emit(ctx, { type: "updateLaneGroup", groupId: group.id, patch });
  }
  if (affected.length > 0 || added.length > 0) {
    reopenRun(ctx);
  }
  for (const lane of lanes) {
    startLane(ctx, groupById(ctx, group.id), laneById(ctx, lane.id));
  }
  recordOverrule(ctx, visit, event, missing);
  checkMerge(ctx, group.id);
  settleRun(ctx);
}

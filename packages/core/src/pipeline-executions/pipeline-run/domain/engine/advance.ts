/**
 * Moving on from a visit that succeeded. In `first` mode: taking the first
 * matching route, spawning lanes for `each` or arriving at a merge for
 * `partial`; when no route is taken the path ends. In `all` mode: one lane
 * per taken route, which may be none.
 */
import type { ReferenceContext } from "@scarn/shared-core/pipelines";
import { contextFor } from "./chain";
import { enterNode } from "./enter";
import { handleError } from "./failure";
import { arriveAtMerge, endPath, spawnSplit } from "./lanes";
import { emit, nodeOf, type EngineContext } from "./state";
import {
  chooseRoutes,
  routeFor,
  routesOf,
  tryResolveArgs,
  tryResolveItems,
} from "./transitions";
import type { Visit, VisitTransition } from "./types";

export function advanceFrom(ctx: EngineContext, visit: Visit): void {
  const node = nodeOf(ctx, visit.nodeId);
  const next = routesOf(node);
  if (next === undefined) {
    endPath(ctx, visit.laneId);
    return;
  }
  const context = contextFor(ctx, visit);
  const choice = chooseRoutes(next, context);
  if (!choice.ok) {
    emit(ctx, {
      type: "updateVisit",
      visitId: visit.id,
      patch: {
        routing: { ...visit.routing, checked: choice.checked, taken: null },
      },
    });
    handleError(ctx, visit, choice.error);
    return;
  }
  const { taken, checked } = choice.choice;
  emit(ctx, {
    type: "updateVisit",
    visitId: visit.id,
    patch: { routing: { ...visit.routing, checked, taken } },
  });
  if (next.match === "all") {
    for (const route of taken.map((entry) => routeFor(node, entry))) {
      const items =
        route?.each === undefined
          ? undefined
          : tryResolveItems(route.each.over, context);
      if (items?.ok === false) {
        handleError(ctx, visit, items.error);
        return;
      }
    }
    spawnSplit(ctx, visit, { kind: "all", routes: taken });
    return;
  }
  const [first] = taken;
  if (first === undefined) {
    endPath(ctx, visit.laneId);
    return;
  }
  takeRoute(ctx, visit, first, context);
}

/**
 * Takes one `first`-mode route out of `visit`: spawns lanes for `each`,
 * arrives at the merge for `partial`, else enters the route's node. A route
 * the node doesn't have ends the path; failing to resolve its items or args
 * is handled as the visit's error.
 */
export function takeRoute(
  ctx: EngineContext,
  visit: Visit,
  entry: VisitTransition,
  context: ReferenceContext,
): void {
  const route = routeFor(nodeOf(ctx, visit.nodeId), entry);
  if (route === undefined) {
    endPath(ctx, visit.laneId);
    return;
  }
  if (route.each !== undefined) {
    const items = tryResolveItems(route.each.over, context);
    if (!items.ok) {
      handleError(ctx, visit, items.error);
      return;
    }
    spawnSplit(ctx, visit, {
      kind: "each",
      route: entry,
      items: items.value,
      parentLaneId: visit.laneId,
    });
    return;
  }
  const args = tryResolveArgs(route.args, context);
  if (!args.ok) {
    handleError(ctx, visit, args.error);
    return;
  }
  if (route.partial === true && visit.laneId !== null) {
    arriveAtMerge(ctx, visit.laneId, route.to, args.value, visit.id, entry);
    return;
  }
  enterNode(ctx, {
    nodeId: route.to,
    input: args.value,
    laneId: visit.laneId,
    fromVisitId: visit.id,
    fromLaneGroupId: null,
    transition: entry,
  });
}

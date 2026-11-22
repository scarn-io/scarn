/**
 * Overrules: a person changes which routes a succeeded step visit took, with
 * a reason. The visit keeps its result. On a `match: "first"` node every
 * visit after it is superseded and the run continues along the chosen route;
 * a `match: "all"` node's lanes are added and removed by `overruleSplit`.
 * Only routes the author marked overridable can be turned on or off.
 */
import { takeRoute } from "./advance";
import { contextFor } from "./chain";
import {
  checkMissingArgs,
  checkOverridable,
  describeRoute,
  missingArgsOf,
  recordOverrule,
  sameRoutes,
  type OverruleEvent,
} from "./overrule-checks";
import { overruleSplit } from "./overrule-split";
import { supersedeAfter } from "./rerun";
import { groupById, laneById, nodeOf, type EngineContext } from "./state";
import { routeFor, routesOf } from "./transitions";
import { DecideError, type Visit } from "./types";

function overrulableVisit(ctx: EngineContext, visitId: string): Visit {
  const visit = ctx.visits.find((candidate) => candidate.id === visitId);
  if (visit === undefined) {
    throw new DecideError(
      "unknown_visit",
      `visit ${visitId} is not in this run`,
    );
  }
  if (ctx.run.status === "cancelled") {
    throw new DecideError(
      "run_not_active",
      "a cancelled run can't be overruled",
    );
  }
  if (visit.status === "superseded") {
    throw new DecideError(
      "invalid_visit_state",
      `visit ${visitId} was already superseded`,
    );
  }
  if (visit.nodeKind !== "step") {
    throw new DecideError(
      "invalid_visit_state",
      `only step visits can be overruled, not "${visit.nodeKind}"`,
    );
  }
  if (visit.status !== "succeeded") {
    throw new DecideError(
      "invalid_visit_state",
      `only succeeded visits can be overruled; visit ${visitId} is ${visit.status}`,
    );
  }
  if (visit.laneId !== null) {
    const group = groupById(ctx, laneById(ctx, visit.laneId).laneGroupId);
    if (group.status === "failed") {
      throw new DecideError(
        "invalid_visit_state",
        `visit ${visitId} is in a lane group that failed`,
      );
    }
  }
  return visit;
}

/** Applies a person's overrule of the routes `event.visitId` took. */
export function overruleRoute(ctx: EngineContext, event: OverruleEvent): void {
  const visit = overrulableVisit(ctx, event.visitId);
  const node = nodeOf(ctx, visit.nodeId);
  const next = routesOf(node);
  const unknown = event.routes.filter(
    (entry) => next === undefined || routeFor(node, entry) === undefined,
  );
  if (next === undefined || unknown.length > 0) {
    throw new DecideError(
      "unknown_route",
      `node "${visit.nodeId}" has no ${unknown.map(describeRoute).join(", ") || "routes"}`,
    );
  }
  const from = visit.routing?.taken ?? [];
  if (sameRoutes(from, event.routes)) {
    throw new DecideError(
      "route_unchanged",
      `visit ${visit.id} already took ${event.routes.map(describeRoute).join(", ") || "no route"}`,
    );
  }
  if (next.match === "all") {
    overruleSplit(ctx, visit, next, event);
    return;
  }
  const [entry] = event.routes;
  if (entry === undefined || event.routes.length !== 1) {
    throw new DecideError(
      "route_set_invalid",
      `node "${visit.nodeId}" takes exactly one route, not ${String(event.routes.length)}`,
    );
  }
  checkOverridable(next, [...from, entry]);
  const context = contextFor(ctx, visit);
  const missing = missingArgsOf(ctx, visit, [entry], context);
  checkMissingArgs(missing, event.missingArgs);
  supersedeAfter(ctx, visit, { includeRoot: false });
  recordOverrule(ctx, visit, event, missing);
  takeRoute(ctx, visit, entry, context);
}

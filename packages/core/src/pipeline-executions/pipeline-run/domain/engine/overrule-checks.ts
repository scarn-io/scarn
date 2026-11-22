/**
 * What every overrule checks and records, whatever the node's `match`: which
 * routes a person may turn on or off, the args a route would be taken
 * without, and the `RouteOverrule` appended to the visit's routing.
 */
import {
  isRouteOverridable,
  type Next,
} from "@scarn/sdk/contracts/pipeline-document";
import type {
  MissingArg,
  ReferenceContext,
} from "@scarn/shared-core/pipelines";
import { laneArgsReporting } from "./lanes";
import { emit, nodeOf, type EngineContext } from "./state";
import {
  routeFor,
  tryResolveArgsReporting,
  tryResolveItems,
} from "./transitions";
import {
  DecideError,
  type EngineEvent,
  type RouteOverrule,
  type Visit,
  type VisitTransition,
} from "./types";

export type OverruleEvent = Extract<EngineEvent, { type: "route_overruled" }>;

export const describeRoute = ({ kind, index }: VisitTransition): string =>
  kind === "otherwise" ? "otherwise" : `${kind} ${String(index)}`;

export const sameRoute = (a: VisitTransition, b: VisitTransition): boolean =>
  a.kind === b.kind && a.index === b.index;

export const sameRoutes = (
  a: readonly VisitTransition[],
  b: readonly VisitTransition[],
): boolean =>
  a.length === b.length &&
  a.every((entry) => b.some((other) => sameRoute(entry, other))) &&
  b.every((entry) => a.some((other) => sameRoute(entry, other)));

/** Refuses the overrule unless every route in `routes` is overridable. */
export function checkOverridable(
  next: Next,
  routes: readonly VisitTransition[],
): void {
  const refused = routes.filter(
    (entry) =>
      (entry.kind !== "route" && entry.kind !== "otherwise") ||
      !isRouteOverridable(next, { kind: entry.kind, index: entry.index }),
  );
  if (refused.length > 0) {
    throw new DecideError(
      "route_not_overridable",
      `${refused.map(describeRoute).join(", ")} can't be overruled: the pipeline doesn't mark ${refused.length === 1 ? "it" : "them"} overridable`,
      { routes: refused },
    );
  }
}

/**
 * The args the routes' targets would be entered without, each distinct one
 * listed once. For an `each` route, each item's lane args are checked.
 * Malformed references and items are left to taking the route, which handles
 * them as the visit's (or the lane's) error.
 */
export function missingArgsOf(
  ctx: EngineContext,
  visit: Visit,
  entries: readonly VisitTransition[],
  context: ReferenceContext,
): MissingArg[] {
  const missing = new Map<string, MissingArg>();
  const add = (args: readonly MissingArg[]) => {
    for (const arg of args) {
      missing.set(`${arg.arg}\u0000${arg.reference}`, arg);
    }
  };
  for (const entry of entries) {
    const route = routeFor(nodeOf(ctx, visit.nodeId), entry);
    if (route === undefined) {
      continue;
    }
    if (route.each === undefined) {
      const outcome = tryResolveArgsReporting(route.args, context);
      add(outcome.ok ? outcome.missing : []);
      continue;
    }
    const items = tryResolveItems(route.each.over, context);
    for (const item of items.ok ? items.value : []) {
      const outcome = laneArgsReporting(ctx, visit, route, item);
      add(outcome.ok ? outcome.missing : []);
    }
  }
  return [...missing.values()];
}

/** Refuses missing args unless the person accepted them. */
export function checkMissingArgs(
  missing: readonly MissingArg[],
  policy: OverruleEvent["missingArgs"],
): void {
  if (missing.length === 0 || policy === "accept") {
    return;
  }
  const list = missing
    .map(({ arg, reference }) => `${arg} (${reference})`)
    .join(", ");
  throw new DecideError(
    "route_args_missing",
    policy === "reject_code_step"
      ? `the route leads to a code step or MCP tool step, which can't run with missing args: ${list}`
      : `the route's args resolve to nothing: ${list}; resend accepting them as missing to continue without them`,
    { missing },
  );
}

/** Sets the visit's taken routes to the event's and appends the overrule. */
export function recordOverrule(
  ctx: EngineContext,
  visit: Visit,
  event: OverruleEvent,
  missing: MissingArg[],
): void {
  const overrule: RouteOverrule = {
    from: visit.routing?.taken ?? [],
    to: event.routes,
    byUserId: event.userId,
    at: ctx.options.now,
    reason: event.reason,
    missingArgs: missing,
  };
  emit(ctx, {
    type: "updateVisit",
    visitId: visit.id,
    patch: {
      routing: {
        ...visit.routing,
        taken: event.routes,
        overrules: [...(visit.routing?.overrules ?? []), overrule],
      },
    },
  });
}

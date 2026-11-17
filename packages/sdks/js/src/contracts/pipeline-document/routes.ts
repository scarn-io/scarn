/** Reading the routes of a node's `next` object. */
import type { Next, Otherwise, Route } from "./schema";

export type RouteKind = "route" | "otherwise";

/** One entry of a `next` object: a route, or the `otherwise` route. */
export interface RouteEntry {
  kind: RouteKind;
  /** The route's index in `routes`, or 0 for `otherwise`. */
  index: number;
  route: Route | Otherwise;
  /** Where the entry sits inside the `next` object. */
  pointer: ["routes", number] | ["otherwise"];
}

/** Every route of `next` in order, with `otherwise` last. */
export function routeEntries(next: Next | undefined): RouteEntry[] {
  if (next === undefined) {
    return [];
  }
  const entries: RouteEntry[] = next.routes.map((route, index) => ({
    kind: "route",
    index,
    route,
    pointer: ["routes", index],
  }));
  if (next.otherwise !== undefined) {
    entries.push({
      kind: "otherwise",
      index: 0,
      route: next.otherwise,
      pointer: ["otherwise"],
    });
  }
  return entries;
}

/** The route a `kind` and `index` name, if `next` has it. */
export function routeAt(
  next: Next | undefined,
  kind: RouteKind,
  index: number,
): Route | Otherwise | undefined {
  if (next === undefined) {
    return undefined;
  }
  return kind === "otherwise" ? next.otherwise : next.routes[index];
}

/**
 * Whether a person may overrule a visit that took this route: the route's own
 * `overridable`, else `next.overridable`. Under `match: "all"` a route without
 * `when` always runs, so it is never overridable.
 */
export function isRouteOverridable(
  next: Next | undefined,
  transition: { kind: RouteKind; index: number },
): boolean {
  const route = routeAt(next, transition.kind, transition.index);
  if (next === undefined || route === undefined) {
    return false;
  }
  if (
    transition.kind === "route" &&
    next.match === "all" &&
    next.routes[transition.index]?.when === undefined
  ) {
    return false;
  }
  return route.overridable ?? next.overridable ?? false;
}

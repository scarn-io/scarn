import type { ConditionRecord } from "../pipelines/conditions/evaluate";

/**
 * Mirrors of the routing a visit records and of the overrule endpoint's
 * bodies (`POST /pipeline-executions/{id}/visits/{visitId}/route`). See
 * `./api-types.ts` for why these are not imported from `@scarn/sdk`.
 */

/** How a visit was entered, or one route a visit took. */
export type VisitTransition = {
  kind: "start" | "route" | "otherwise" | "catch" | "merge";
  index: number;
};

/** One `when` the engine checked when the visit finished. */
export type CheckedTransition = {
  index: number;
  when: ConditionRecord | null;
  matched: boolean;
};

export type MissingArg = { arg: string; reference: string };

/** A person changing which routes a visit took. */
export type RouteOverrule = {
  from: VisitTransition[];
  to: VisitTransition[];
  byUserId: string;
  at: string;
  reason: string;
  missingArgs: MissingArg[];
};

/** A visit's `routing`: what was checked, what was taken, and its overrules. */
export type VisitRouting = {
  checked?: CheckedTransition[];
  /** Empty when the path ended; null when not routed yet. */
  taken?: VisitTransition[] | null;
  overrules?: RouteOverrule[];
};

/** Names one route of a node: by position or `otherwise`. */
export type RouteSelector =
  { kind: "route"; index: number } | { kind: "otherwise" };

export type OverruleRequest = {
  routes: RouteSelector[];
  reason: string;
  acceptMissing: boolean;
  preview: boolean;
};

type PreviewLane = { route: VisitTransition; label?: string };

/** What an overrule would do, without doing it. */
export type OverrulePreview = {
  superseded: { visitId: string; nodeId: string; status: string }[];
  cancelledTasks: number;
  lanesAdded: PreviewLane[];
  lanesRemoved: PreviewLane[];
  mergesRerun: string[];
  started: string[];
  reopensRun: boolean;
  missing: MissingArg[];
};

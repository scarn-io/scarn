/**
 * Choosing and resolving routes: evaluating `when` in order and resolving
 * args. Failures come back
 * as named engine errors so they can go through `catch`.
 */
import {
  routeAt,
  type JsonObject,
  type JsonValue,
  type Next,
  type Otherwise,
  type PipelineNode,
  type Route,
} from "@scarn/sdk/contracts/pipeline-document";
import {
  ConditionError,
  evaluateCondition,
  type MissingArg,
  type ReferenceContext,
  resolveArgs,
  resolveArgsReporting,
  resolveReferenceString,
} from "@scarn/shared-core/pipelines";
import {
  ENGINE_ERRORS,
  type CheckedTransition,
  type EngineError,
  type ToleratedFailures,
  type VisitTransition,
} from "./types";

export type Outcome<T> =
  { ok: true; value: T } | { ok: false; error: EngineError };

/** Runs `fn`, turning a thrown error into a named engine error (`Scarn.ConditionError` for condition errors). */
function attempt<T>(fn: () => T, fallbackName: string): Outcome<T> {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    if (error instanceof ConditionError) {
      return {
        ok: false,
        error: { name: ENGINE_ERRORS.conditionError, message: error.message },
      };
    }
    return {
      ok: false,
      error: {
        name: fallbackName,
        message: error instanceof Error ? error.message : "Unknown error",
      },
    };
  }
}

export function tryResolveArgs(
  args: Route["args"],
  context: ReferenceContext,
): Outcome<JsonObject> {
  return attempt(() => resolveArgs(args, context), ENGINE_ERRORS.argsError);
}

/** An {@link Outcome} that, when resolved, also lists the args that resolved to nothing. */
export type ReportingOutcome<T> =
  | { ok: true; value: T; missing: MissingArg[] }
  | { ok: false; error: EngineError };

/** {@link tryResolveArgs}, also reporting the args whose reference resolved to nothing. */
export function tryResolveArgsReporting(
  args: Route["args"],
  context: ReferenceContext,
): ReportingOutcome<JsonObject> {
  const outcome = attempt(
    () => resolveArgsReporting(args, context),
    ENGINE_ERRORS.argsError,
  );
  if (!outcome.ok) {
    return outcome;
  }
  return {
    ok: true,
    value: outcome.value.resolved,
    missing: outcome.value.missing,
  };
}

/** Resolves `each.over`; anything but an array is an args error. */
export function tryResolveItems(
  over: string,
  context: ReferenceContext,
): Outcome<JsonValue[]> {
  const resolved = attempt(
    () => resolveReferenceString(over, context),
    ENGINE_ERRORS.argsError,
  );
  if (!resolved.ok) {
    return resolved;
  }
  if (!Array.isArray(resolved.value)) {
    return {
      ok: false,
      error: {
        name: ENGINE_ERRORS.argsError,
        message: `"each.over" (${over}) is not an array`,
      },
    };
  }
  return { ok: true, value: resolved.value };
}

export interface Choice {
  /** The routes taken; empty when nothing matched and there's no `otherwise`, which ends the path. */
  taken: VisitTransition[];
  checked: CheckedTransition[];
}

/**
 * First mode: takes the first route whose `when` matches (or has no `when`),
 * or `otherwise` when none did. All mode: takes every route whose `when`
 * matches or that has none, plus `otherwise` when no route with a `when`
 * matched. Every check is recorded.
 */
export function chooseRoutes(
  next: Next,
  context: ReferenceContext,
):
  | { ok: true; choice: Choice }
  | {
      ok: false;
      error: EngineError;
      checked: CheckedTransition[];
    } {
  const all = next.match === "all";
  const checked: CheckedTransition[] = [];
  const taken: VisitTransition[] = [];
  let conditionMatched = false;
  for (const [index, route] of next.routes.entries()) {
    const { when } = route;
    if (when === undefined) {
      checked.push({ index, when: null, matched: true });
      taken.push({ kind: "route", index });
      if (!all) {
        return { ok: true, choice: { taken, checked } };
      }
      continue;
    }
    const outcome = attempt(
      () => evaluateCondition(when, context),
      ENGINE_ERRORS.conditionError,
    );
    if (!outcome.ok) {
      return { ok: false, error: outcome.error, checked };
    }
    checked.push({
      index,
      when: outcome.value.record,
      matched: outcome.value.value,
    });
    if (outcome.value.value) {
      conditionMatched = true;
      taken.push({ kind: "route", index });
      if (!all) {
        return { ok: true, choice: { taken, checked } };
      }
    }
  }
  if (!conditionMatched && next.otherwise !== undefined) {
    taken.push({ kind: "otherwise", index: 0 });
  }
  return { ok: true, choice: { taken, checked } };
}

/** A node's `next`, or undefined for terminals and nodes whose path ends there. */
export function routesOf(node: PipelineNode): Next | undefined {
  return node.kind === "step" || node.kind === "wait" ? node.next : undefined;
}

/** The route a taken `route` / `otherwise` transition names. */
export function routeFor(
  node: PipelineNode,
  taken: VisitTransition,
): Route | Otherwise | undefined {
  if (taken.kind !== "route" && taken.kind !== "otherwise") {
    return undefined;
  }
  return routeAt(routesOf(node), taken.kind, taken.index);
}

export function exceedsTolerance(
  tolerated: ToleratedFailures,
  failed: number,
  laneCount: number,
): boolean {
  if ("count" in tolerated) {
    return failed > tolerated.count;
  }
  return laneCount > 0 && (failed / laneCount) * 100 > tolerated.percent;
}

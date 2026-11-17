import {
  isRouteOverridable,
  nextSchema,
  routeEntries,
  type Next,
} from "@scarn/sdk/contracts/pipeline-document";
import { ActionError, actionErrorKind, unwrapAction } from "./lib/action-error";
import type { RunActionClient } from "./lib/action-clients";
import { describeApiError } from "./lib/api-errors";
import type { ApiResult, AuthHeaders } from "./lib/api-result";
import type {
  CheckedTransition,
  MissingArg,
  OverrulePreview,
  RouteOverrule,
  RouteSelector,
  VisitTransition,
} from "./lib/route-api-types";
import type { RunWithVisits } from "./lib/run-api-types";
import { loadRun, resolveTarget, type TargetVisit } from "./run-actions";

/**
 * Overruling the routes a step visit took (`scarn runs route`): load the
 * visit with its node's routes from the run's pinned pipeline, turn the
 * person's choice into the full set of routes to take, preview it, then
 * apply it.
 */

type RouteActionOptions = {
  client: RunActionClient;
  headers: AuthHeaders;
  runId: string;
};

/** One route of the node, as the listing and the choice see it. */
export type RouteOption = {
  kind: "route" | "otherwise";
  index: number;
  to: string;
  label: string | undefined;
  /** Whether the route has a `when`; `otherwise` never does. */
  conditional: boolean;
  overridable: boolean;
  taken: boolean;
  /** The `when` the engine checked for this route, if it got that far. */
  checked: CheckedTransition | undefined;
};

/** A step visit with its node's routes and what it took. */
export type RouteContext = {
  run: RunWithVisits;
  target: TargetVisit;
  match: "first" | "all";
  options: RouteOption[];
  /** Empty when the path ended; null when the visit hasn't routed. */
  taken: VisitTransition[] | null;
  overrules: RouteOverrule[];
};

async function pinnedNext(
  options: RouteActionOptions,
  run: RunWithVisits,
  nodeId: string,
): Promise<Next | undefined> {
  const { client, headers } = options;
  const path = { pipelineDefinitionId: run.pipelineDefinitionId };
  const versions = unwrapAction(
    "list the pipeline's versions",
    await client.pipelineDefinitions.listPipelineDefinitionVersions({
      path,
      headers,
    }),
  );
  const pinned = versions.find(
    (version) => version.id === run.pipelineDefinitionVersionId,
  );
  if (pinned === undefined) {
    throw new ActionError(
      "not_found",
      `The pipeline version ${run.pipelineDefinitionVersionId} the run pinned was not found.`,
    );
  }
  const version = unwrapAction(
    `load version ${String(pinned.version)} of the pipeline`,
    await client.pipelineDefinitions.getPipelineDefinitionVersion({
      path: { ...path, version: pinned.version },
      headers,
    }),
  );
  const nodes = version.definition["nodes"] as
    Record<string, { kind?: unknown; next?: unknown } | undefined> | undefined;
  const node = nodes?.[nodeId];
  if (node?.kind !== "step" || node.next === undefined) return undefined;
  const parsed = nextSchema.safeParse(node.next);
  if (!parsed.success) {
    throw new ActionError(
      "failed",
      `The routes of "${nodeId}" in the run's pipeline don't match the schema this CLI knows.`,
    );
  }
  return parsed.data;
}

const isTaken = (
  taken: readonly VisitTransition[] | null,
  kind: RouteOption["kind"],
  index: number,
) =>
  (taken ?? []).some(
    (transition) => transition.kind === kind && transition.index === index,
  );

/** Loads the `--step` visit and the routes its node could take. */
export async function loadRouteContext(
  options: RouteActionOptions & {
    stepKey: string;
    attempt: number | undefined;
  },
): Promise<RouteContext> {
  const run = await loadRun(options);
  const resolved = resolveTarget(run, options.stepKey, options.attempt);
  const { visit } = resolved;
  if (visit.nodeKind !== "step") {
    throw new ActionError(
      "rejected",
      `"${options.stepKey}" is a ${visit.nodeKind} node; only a step's routes can be overruled.`,
    );
  }
  const next = await pinnedNext(options, run, visit.nodeId);
  const taken = visit.routing?.taken ?? null;
  const checked = visit.routing?.checked ?? [];
  return {
    run,
    target: {
      stepKey: options.stepKey,
      visit,
      attemptNumber: resolved.attemptNumber,
    },
    match: next?.match ?? "first",
    options: routeEntries(next).map((entry) => ({
      kind: entry.kind,
      index: entry.index,
      to: entry.route.to,
      label: entry.route.label,
      conditional: "when" in entry.route && entry.route.when !== undefined,
      overridable: isRouteOverridable(next, entry),
      taken: isTaken(taken, entry.kind, entry.index),
      checked:
        entry.kind === "route"
          ? checked.find((check) => check.index === entry.index)
          : undefined,
    })),
    taken,
    overrules: visit.routing?.overrules ?? [],
  };
}

/** How `--to`, `--label`, `--otherwise`, `--add` and `--remove` name a route. */
export type RouteChoice =
  | { kind: "to"; node: string }
  | { kind: "label"; label: string }
  | { kind: "otherwise" }
  | { kind: "change"; add: string[]; remove: string[] };

/** `routes[2]`, `otherwise`, with its label when it has one. */
export function describeRouteOption(option: RouteOption): string {
  const name =
    option.kind === "otherwise"
      ? "otherwise"
      : `routes[${String(option.index)}]`;
  const label = option.label === undefined ? "" : ` "${option.label}"`;
  return `${name}${label} → ${option.to}`;
}

function findOne(
  context: RouteContext,
  candidates: RouteOption[],
  what: string,
): RouteOption {
  const [only, ...rest] = candidates;
  if (only === undefined) {
    const known = context.options.map(describeRouteOption).join(", ");
    throw new ActionError(
      "not_found",
      `Step "${context.target.stepKey}" has no route ${what}. Its routes: ${known || "(none)"}.`,
    );
  }
  if (rest.length > 0) {
    throw new ActionError(
      "rejected",
      `More than one route of step "${context.target.stepKey}" goes ${what}; pick it by --label.`,
    );
  }
  return only;
}

/** A label first, else the route's target node. */
function findByReference(context: RouteContext, reference: string) {
  const byLabel = context.options.filter(
    (option) => option.label === reference,
  );
  if (byLabel.length > 0) return findOne(context, byLabel, `"${reference}"`);
  return findOne(
    context,
    context.options.filter((option) => option.to === reference),
    `labelled or going to "${reference}"`,
  );
}

const selectorOf = (option: RouteOption): RouteSelector =>
  option.kind === "otherwise"
    ? { kind: "otherwise" }
    : { kind: "route", index: option.index };

function pickOne(context: RouteContext, choice: RouteChoice): RouteOption {
  if (choice.kind === "otherwise") {
    return findOne(
      context,
      context.options.filter((option) => option.kind === "otherwise"),
      "otherwise",
    );
  }
  if (choice.kind === "label") {
    return findOne(
      context,
      context.options.filter((option) => option.label === choice.label),
      `labelled "${choice.label}"`,
    );
  }
  if (choice.kind === "to") {
    return findOne(
      context,
      context.options.filter((option) => option.to === choice.node),
      `to "${choice.node}"`,
    );
  }
  throw new ActionError(
    "rejected",
    "--add and --remove only go with a match: all node.",
  );
}

function changeSet(
  context: RouteContext,
  add: readonly string[],
  remove: readonly string[],
): RouteOption[] {
  const chosen = new Set(
    context.options.filter((option) => option.kind === "route" && option.taken),
  );
  const resolve = (reference: string) => {
    const option = findByReference(context, reference);
    if (option.kind === "otherwise") {
      throw new ActionError(
        "rejected",
        "otherwise can't be added or removed: it's taken when no route with a when is.",
      );
    }
    if (!option.conditional) {
      throw new ActionError(
        "rejected",
        `${describeRouteOption(option)} has no when, so it always runs.`,
      );
    }
    return option;
  };
  for (const reference of add) chosen.add(resolve(reference));
  for (const reference of remove) chosen.delete(resolve(reference));
  const routes = context.options.filter(
    (option) =>
      option.kind === "route" && (chosen.has(option) || !option.conditional),
  );
  const otherwise = context.options.find(
    (option) => option.kind === "otherwise",
  );
  const anyConditional = routes.some((option) => option.conditional);
  return otherwise === undefined || anyConditional
    ? routes
    : [...routes, otherwise];
}

/**
 * The full set of routes the overrule sends: the one picked on a
 * `match: "first"` node, or on a `match: "all"` node the routes taken with
 * `add` and `remove` applied, unconditional routes kept, and `otherwise`
 * worked out from the rest.
 */
export function planOverrule(
  context: RouteContext,
  choice: RouteChoice,
): { routes: RouteSelector[]; options: RouteOption[] } {
  const options =
    choice.kind === "change"
      ? changeSet(context, choice.add, choice.remove)
      : [pickOne(context, choice)];
  return { routes: options.map(selectorOf), options };
}

/** An overrule the API refused, with the refusal's code and details. */
export class RouteRefusal extends ActionError {
  public constructor(
    message: string,
    public readonly code: string | undefined,
    public readonly missing: MissingArg[],
    public readonly routes: VisitTransition[],
  ) {
    super("rejected", message);
    this.name = "RouteRefusal";
  }
}

function unwrapOverrule<T>(what: string, result: ApiResult<T>): T {
  const { error } = result;
  if (error === undefined) return result.data;
  const message = `Could not ${what}: ${describeApiError(error)}`;
  if (actionErrorKind(error.status) !== "rejected") {
    throw new ActionError(actionErrorKind(error.status), message);
  }
  const { missing, routes } = error.meta ?? {};
  throw new RouteRefusal(
    message,
    error.code,
    Array.isArray(missing) ? (missing as MissingArg[]) : [],
    Array.isArray(routes) ? (routes as VisitTransition[]) : [],
  );
}

type OverruleOptions = RouteActionOptions & {
  visitId: string;
  stepKey: string;
  routes: RouteSelector[];
  reason: string;
  acceptMissing: boolean;
};

const overrule = (options: OverruleOptions, preview: boolean) =>
  options.client.pipelineExecutions.overrulePipelineExecutionRoute({
    path: { pipelineExecutionId: options.runId, visitId: options.visitId },
    body: {
      routes: options.routes,
      reason: options.reason,
      acceptMissing: options.acceptMissing,
      preview,
    },
    headers: options.headers,
  });

/** What the overrule would do; throws a {@link RouteRefusal} when refused. */
export async function previewOverrule(
  options: OverruleOptions,
): Promise<OverrulePreview> {
  const result = unwrapOverrule(
    `overrule the routes of step "${options.stepKey}"`,
    await overrule(options, true),
  );
  if (!("preview" in result)) {
    throw new ActionError("failed", "The API returned no preview.");
  }
  return result.preview;
}

/** Applies the overrule; throws a {@link RouteRefusal} when refused. */
export async function overruleRoute(
  options: OverruleOptions,
): Promise<RunWithVisits> {
  const result = unwrapOverrule(
    `overrule the routes of step "${options.stepKey}"`,
    await overrule(options, false),
  );
  if ("preview" in result) {
    throw new ActionError("failed", "The API returned a preview.");
  }
  return result;
}

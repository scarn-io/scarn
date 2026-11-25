/**
 * Reading a visit's routing and its node's routes for the run page's Route
 * section and Overrule dialog: which routes a visit took, which a person may
 * change (see `isRouteOverridable`), how the conditions checked read, and
 * what a preview of an overrule would do.
 */
import {
  isRouteOverridable,
  routeEntries,
  type JsonValue,
  type Next,
  type PipelineDocument,
  type RouteKind,
} from "@scarn/sdk/contracts/pipeline-document";
import { z } from "zod";
import type {
  NodeVisitContract,
  PipelineExecutionContract,
  PipelineVersionContract,
} from "@scarn/api/frontend-contracts";
import type { OverrulePreviewResult } from "@scarn/core/pipeline-executions/pipeline-run/contracts/overrule-contracts";
import {
  edgeMarkKey,
  type EdgeOverruleMark,
} from "@/components/pipeline-graph/pipeline-graph-run-decoration";

export type RouteRef = { kind: RouteKind; index: number };

export type OverrulePreview = OverrulePreviewResult["preview"];

export type ConditionRecord =
  | { kind: "all" | "any"; result: boolean; conditions: ConditionRecord[] }
  | { kind: "not"; result: boolean; condition: ConditionRecord }
  | {
      kind: "compare";
      result: boolean;
      left: { path?: string; computed?: string; value: JsonValue | null };
      op: string;
      right?: { ref?: string; value: JsonValue | null };
    }
  | {
      kind: "list";
      result: boolean;
      path: string;
      op: string;
      length: number;
      matchedIndexes: number[];
    };

export type CheckedRoute = {
  index: number;
  when: ConditionRecord | null;
  matched: boolean;
};

export type RouteOverruleRecord = {
  from: RouteRef[];
  to: RouteRef[];
  byUserId: string;
  at: string;
  reason: string;
  missingArgs: { arg: string; reference: string }[];
};

export type VisitRouting = {
  checked: CheckedRoute[];
  /** `null` when routing failed (a condition error). */
  taken: RouteRef[] | null;
  overrules: RouteOverruleRecord[];
};

/** One route of a node, as the dialog and Route section show it. */
export type RouteChoice = RouteRef & {
  key: string;
  label: string;
  to: string;
  overridable: boolean;
  /** Whether the route always runs (a `match: "all"` route without `when`). */
  unconditional: boolean;
};

const routeRefSchema = z.object({
  kind: z.enum(["route", "otherwise"]),
  index: z.number().int().nonnegative(),
});

const routingSchema = z.object({
  checked: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        when: z.looseObject({ kind: z.string() }).nullable(),
        matched: z.boolean(),
      }),
    )
    .catch([]),
  taken: z.array(routeRefSchema).nullable().catch(null),
  overrules: z
    .array(
      z.object({
        from: z.array(routeRefSchema),
        to: z.array(routeRefSchema),
        byUserId: z.string(),
        at: z.string(),
        reason: z.string(),
        missingArgs: z
          .array(z.object({ arg: z.string(), reference: z.string() }))
          .catch([]),
      }),
    )
    .catch([]),
});

/** The visit's `routing` record (free-form JSON in the contract), parsed; `null` when it has none. */
export function readVisitRouting(
  routing: NodeVisitContract["routing"],
): VisitRouting | null {
  if (routing === null) return null;
  const parsed = routingSchema.safeParse(routing);
  if (!parsed.success) return null;
  return {
    ...parsed.data,
    checked: parsed.data.checked.map((entry) => ({
      ...entry,
      when: entry.when as ConditionRecord | null,
    })),
  };
}

export const routeKey = (route: RouteRef): string =>
  route.kind === "otherwise" ? "otherwise" : `route:${String(route.index)}`;

export const sameRoute = (left: RouteRef, right: RouteRef): boolean =>
  left.kind === right.kind &&
  (left.kind === "otherwise" || left.index === right.index);

function documentOf(
  version: PipelineVersionContract | null,
): PipelineDocument | null {
  return version ? (version.definition as unknown as PipelineDocument) : null;
}

/** A node's title from the pinned document, else its id. */
export function nodeTitle(
  version: PipelineVersionContract | null,
  nodeId: string,
): string {
  return documentOf(version)?.nodes[nodeId]?.title ?? nodeId;
}

/** The `next` of a step or wait node in the pinned document. */
export function nodeNext(
  version: PipelineVersionContract | null,
  nodeId: string,
): Next | undefined {
  const node = documentOf(version)?.nodes[nodeId];
  return node && (node.kind === "step" || node.kind === "wait")
    ? node.next
    : undefined;
}

/** Every route of a node, by label, else "→ target title". */
export function routeChoices(
  version: PipelineVersionContract | null,
  next: Next | undefined,
): RouteChoice[] {
  return routeEntries(next).map((entry) => {
    const ref = { kind: entry.kind, index: entry.index };
    return {
      ...ref,
      key: routeKey(ref),
      label: entry.route.label ?? `→ ${nodeTitle(version, entry.route.to)}`,
      to: entry.route.to,
      overridable: isRouteOverridable(next, ref),
      unconditional:
        next?.match === "all" &&
        entry.kind === "route" &&
        next.routes[entry.index]?.when === undefined,
    };
  });
}

/** How the node's routes read when taken, e.g. "Fix it, → Summarise". */
export function describeRoutes(
  choices: readonly RouteChoice[],
  routes: readonly RouteRef[],
): string {
  if (routes.length === 0) return "no route";
  return routes
    .map(
      (route) =>
        choices.find((choice) => sameRoute(choice, route))?.label ??
        routeKey(route),
    )
    .join(", ");
}

/**
 * Whether any overrule of a visit that took `taken` is allowed by the
 * document: under `match: "first"` the taken route (if any) and at least one
 * other must be overridable; under `match: "all"` at least one route must be.
 */
export function overruleAllowedByDocument(
  next: Next | undefined,
  taken: readonly RouteRef[],
): boolean {
  const choices = routeEntries(next).map((entry) => ({
    kind: entry.kind,
    index: entry.index,
  }));
  const overridable = choices.filter((choice) =>
    isRouteOverridable(next, choice),
  );
  if (next?.match === "all") return overridable.length > 0;
  const [current] = taken;
  if (current === undefined) return overridable.length > 0;
  return (
    isRouteOverridable(next, current) &&
    overridable.some((choice) => !sameRoute(choice, current))
  );
}

/**
 * Under `match: "all"`, the full route set for the boxes ticked: every
 * unconditional route, the ticked conditional ones, and `otherwise` exactly
 * when no conditional route is ticked.
 */
export function allModeRouteSet(
  choices: readonly RouteChoice[],
  ticked: ReadonlySet<string>,
): RouteRef[] {
  const conditional = choices.filter(
    (choice) =>
      choice.kind === "route" &&
      !choice.unconditional &&
      ticked.has(choice.key),
  );
  const set: RouteRef[] = choices
    .filter(
      (choice) =>
        choice.kind === "route" &&
        (choice.unconditional || ticked.has(choice.key)),
    )
    .map(({ kind, index }) => ({ kind, index }));
  if (
    conditional.length === 0 &&
    choices.some((choice) => choice.kind === "otherwise")
  ) {
    set.push({ kind: "otherwise", index: 0 });
  }
  return set;
}

export const sameRouteSet = (
  left: readonly RouteRef[],
  right: readonly RouteRef[],
): boolean =>
  left.length === right.length &&
  left.every((route) => right.some((other) => sameRoute(route, other)));

const OPERATOR_SYMBOLS: Record<string, string> = {
  equal: "=",
  notEqual: "≠",
  lessThan: "<",
  lessThanInclusive: "≤",
  greaterThan: ">",
  greaterThanInclusive: "≥",
};

function formatValue(value: JsonValue | null | undefined): string {
  if (value === undefined || value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/** One condition record as a line, e.g. "reproductionConfidence 0.78 ≥ 0.8". */
export function describeCondition(record: ConditionRecord): string {
  switch (record.kind) {
    case "all":
    case "any":
      return record.conditions
        .map((condition) => `(${describeCondition(condition)})`)
        .join(record.kind === "all" ? " and " : " or ");
    case "not":
      return `not (${describeCondition(record.condition)})`;
    case "list":
      return `${record.path} ${record.op} (${String(record.matchedIndexes.length)} of ${String(record.length)} matched)`;
    case "compare": {
      const path = record.left.path ?? "";
      const left = record.left.computed
        ? `${record.left.computed}(${path})`
        : path;
      const op = OPERATOR_SYMBOLS[record.op] ?? record.op;
      const right = record.right
        ? ` ${record.right.ref ? `${record.right.ref} ` : ""}${formatValue(record.right.value)}`
        : "";
      return `${left} ${formatValue(record.left.value)} ${op}${right}`;
    }
  }
}

const plural = (count: number, word: string) =>
  `${String(count)} ${word}${count === 1 ? "" : "s"}`;

/** What a preview says the overrule would do, e.g. "Cancels 2 lanes (1 running Task), reruns Summarise, reopens the run". */
export function describePreview(
  preview: OverrulePreview,
  titleOf: (nodeId: string) => string,
): string {
  const parts: string[] = [];
  const tasks =
    preview.cancelledTasks > 0
      ? plural(preview.cancelledTasks, "running Task")
      : null;
  if (preview.lanesRemoved.length > 0) {
    parts.push(
      `cancels ${plural(preview.lanesRemoved.length, "lane")}${tasks ? ` (${tasks})` : ""}`,
    );
  } else if (preview.superseded.length > 0) {
    parts.push(
      `supersedes ${plural(preview.superseded.length, "visit")}${tasks ? ` (cancels ${tasks})` : ""}`,
    );
  } else if (tasks) {
    parts.push(`cancels ${tasks}`);
  }
  if (preview.lanesAdded.length > 0) {
    parts.push(`adds ${plural(preview.lanesAdded.length, "lane")}`);
  }
  if (preview.started.length > 0) {
    parts.push(`starts ${preview.started.map(titleOf).join(", ")}`);
  }
  if (preview.mergesRerun.length > 0) {
    parts.push(`reruns ${preview.mergesRerun.map(titleOf).join(", ")}`);
  }
  if (preview.reopensRun) parts.push("reopens the run");
  const sentence = parts.join(", ");
  return sentence
    ? `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`
    : "Changes nothing else in the run";
}

/**
 * A failed run whose fail node was reached through an overridable route of
 * a succeeded step visit, when another overridable route exists: the visit
 * a person could overrule, and the fail node's title.
 */
export function failedRunOverrule(
  execution: Pick<
    PipelineExecutionContract,
    "runStatus" | "endNodeId" | "visits"
  >,
  version: PipelineVersionContract | null,
): { visit: NodeVisitContract; endTitle: string } | null {
  if (execution.runStatus !== "failed" || execution.endNodeId === null) {
    return null;
  }
  const end = [...execution.visits]
    .reverse()
    .find(
      (visit) =>
        visit.nodeId === execution.endNodeId &&
        visit.nodeKind === "fail" &&
        visit.status !== "superseded",
    );
  if (!end || end.fromVisitId === null) return null;
  const from = execution.visits.find((visit) => visit.id === end.fromVisitId);
  if (from?.nodeKind !== "step" || from.status !== "succeeded") return null;
  const { kind, index } = end.transition;
  if (!(kind === "route" || kind === "otherwise")) return null;
  const next = nodeNext(version, from.nodeId);
  const reached: RouteRef = { kind, index };
  if (!isRouteOverridable(next, reached)) return null;
  const others = routeEntries(next).filter(
    (entry) => !sameRoute(entry, reached) && isRouteOverridable(next, entry),
  );
  if (others.length === 0) return null;
  return { visit: from, endTitle: nodeTitle(version, end.nodeId) };
}

/**
 * The graph's overrule marks, keyed by `edgeMarkKey`: a route a person
 * turned on is `overruled` (with their reason); one they turned off is
 * `superseded`, unless a current visit of the node still takes it. In
 * `match: "all"` that marks an added lane overruled and a removed one
 * superseded.
 */
export function overruleEdgeMarks(
  visits: readonly NodeVisitContract[],
): Map<string, EdgeOverruleMark> {
  const marks = new Map<string, EdgeOverruleMark>();
  const current = visits.filter((visit) => visit.status !== "superseded");
  const markKey = (nodeId: string, route: RouteRef) =>
    edgeMarkKey(
      nodeId,
      route.kind,
      route.kind === "otherwise" ? 0 : route.index,
    );
  const takenNow = new Set<string>();
  for (const visit of current) {
    for (const route of readVisitRouting(visit.routing)?.taken ?? []) {
      takenNow.add(markKey(visit.nodeId, route));
    }
  }
  for (const visit of current) {
    const latest = readVisitRouting(visit.routing)?.overrules.at(-1);
    if (!latest) continue;
    for (const route of latest.from) {
      const key = markKey(visit.nodeId, route);
      if (!takenNow.has(key) && !marks.has(key)) {
        marks.set(key, { kind: "superseded" });
      }
    }
    for (const route of latest.to) {
      if (latest.from.some((before) => sameRoute(before, route))) continue;
      marks.set(markKey(visit.nodeId, route), {
        kind: "overruled",
        reason: latest.reason,
      });
    }
  }
  return marks;
}

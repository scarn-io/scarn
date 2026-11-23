import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import type { WorkItemEntity } from "@scarn/core/work-items/work-item/domain/work-item-entity";
import type {
  AutomationRoute,
  AutomationRule,
  AutomationTargetJson,
  WorkItemEvent,
} from "@scarn/sdk/contracts/automation-document";
import type {
  ComputedSource,
  Condition,
  JsonValue,
} from "@scarn/sdk/contracts/pipeline-document";
import {
  evaluateCondition,
  resolveArgs,
  type Arg,
  type ReferenceContext,
} from "@scarn/shared-core/pipelines";

/** The plain values a rule's `event.workItem` and `event.child` refs read. */
export type EventWorkItemValues = {
  title: string;
  description: string | null;
  labels: string[];
  state: string;
  fields: Record<string, AnyJsonValue>;
};

/**
 * An event about a work item as a rule sees it: `workItem` is the work item
 * the rule is about (the parent on `child.*` events), `child` the child work
 * item, and `label` the added label on `workItem.label.added`.
 */
export type WorkItemEventContext = {
  event: WorkItemEvent;
  workItem: WorkItemEntity;
  child: WorkItemEntity | null;
  label: string | null;
};

/** The plain values a `schedule` rule's `event.schedule` refs read; times are ISO strings. */
export type ScheduleEventValues = {
  key: string;
  scheduledFor: string;
  previousScheduledFor: string | null;
  timezone: string;
};

/** A schedule's fire as its rule sees it: about no work item. */
export type ScheduleEventContext = {
  event: "schedule";
  schedule: ScheduleEventValues;
};

export type AutomationEventContext = WorkItemEventContext | ScheduleEventContext;

const valuesOf = (workItem: WorkItemEntity): EventWorkItemValues => ({
  title: workItem.title,
  description: workItem.description,
  labels: [...workItem.labels],
  state: workItem.state,
  fields: { ...workItem.fields },
});

/**
 * The pipeline evaluator reads plain data paths under `item`, so an
 * `event.<rest>` ref is read as `item.<rest>` over the event's values.
 */
const toReferenceContext = (
  context: AutomationEventContext,
): ReferenceContext =>
  context.event === "schedule"
    ? { item: { schedule: { ...context.schedule } } }
    : {
        item: {
          workItem: valuesOf(context.workItem),
          ...(context.child ? { child: valuesOf(context.child) } : {}),
          ...(context.label === null ? {} : { label: context.label }),
        },
      };

const EVENT_PREFIX = "event.";

const rewriteRef = (text: string): string =>
  text.startsWith(EVENT_PREFIX)
    ? `item.${text.slice(EVENT_PREFIX.length)}`
    : text;

const rewriteSource = (source: ComputedSource): ComputedSource =>
  Array.isArray(source)
    ? source.map(rewriteRef)
    : { ...source, path: rewriteRef(source.path) };

/**
 * Rewrites a condition's refs. Inside `where`, `path` is relative to the
 * list element, so only `ref` (always read from the event) is rewritten.
 */
const rewriteCondition = (condition: Condition, inWhere = false): Condition => {
  const rewritten: Condition = { ...condition };
  if (condition.all) {
    rewritten.all = condition.all.map((each) =>
      rewriteCondition(each, inWhere),
    );
  }
  if (condition.any) {
    rewritten.any = condition.any.map((each) =>
      rewriteCondition(each, inWhere),
    );
  }
  if (condition.not) {
    rewritten.not = rewriteCondition(condition.not, inWhere);
  }
  if (condition.where) {
    rewritten.where = rewriteCondition(condition.where, true);
  }
  if (condition.ref !== undefined) {
    rewritten.ref = rewriteRef(condition.ref);
  }
  if (!inWhere) {
    if (condition.path !== undefined) {
      rewritten.path = rewriteRef(condition.path);
    }
    for (const fn of ["sum", "avg", "min", "max", "count"] as const) {
      const source = condition[fn];
      if (source !== undefined) {
        rewritten[fn] = rewriteSource(source);
      }
    }
  }
  return rewritten;
};

const rewriteArg = (arg: Arg): Arg => {
  if (typeof arg === "string") {
    return rewriteRef(arg);
  }
  if ("list" in arg) {
    return {
      list: arg.list.map((each) =>
        typeof each === "string" ? rewriteRef(each) : each,
      ),
    };
  }
  return arg;
};

/** Whether the route's `when` holds for the event (a route without one always does). */
export const routeMatches = (
  route: AutomationRoute,
  context: AutomationEventContext,
): boolean =>
  route.when === undefined ||
  evaluateCondition(rewriteCondition(route.when), toReferenceContext(context))
    .value;

/** A step target's args, read from the event. */
export const resolveTargetArgs = (
  args: Extract<AutomationTargetJson, { kind: "step" }>["args"],
  context: AutomationEventContext,
): Record<string, JsonValue> | null => {
  if (args === undefined) {
    return null;
  }
  const rewritten = Object.fromEntries(
    Object.entries(args).map(([name, arg]) => [name, rewriteArg(arg)]),
  );
  return resolveArgs(rewritten, toReferenceContext(context));
};

/** The targets a rule's `next` picks for the event: the first matching route, every one with `match: "all"`, else `otherwise`. */
export const selectTargets = (
  rule: AutomationRule,
  context: AutomationEventContext,
): AutomationTargetJson[] => {
  const matching =
    rule.next.match === "all"
      ? rule.next.routes.filter((route) => routeMatches(route, context))
      : rule.next.routes
          .filter((route) => routeMatches(route, context))
          .slice(0, 1);
  if (matching.length > 0) {
    return matching;
  }
  return rule.next.otherwise ? [rule.next.otherwise] : [];
};

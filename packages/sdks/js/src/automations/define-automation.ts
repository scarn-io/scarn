/**
 * `defineAutomation` and `onEvent`: runs each rule's callbacks once, with an
 * `r` of placeholders for the event, and compiles the rules to an automation
 * JSON document (format in `contracts/automation-document/schema.ts`). It
 * throws `PipelineBuildError` when a rule can't be compiled; whether its
 * targets exist is checked when the automation is published.
 */
import {
  eventHasChild,
  scopeOfEvent,
  type AutomationDocument,
  type AutomationEvent,
  type AutomationScope,
  type AutomationSubject,
} from "../contracts/automation-document";
import type { ArgValue, JsonSchema } from "../contracts/pipeline-document";
import { argEntries, compileArg } from "../pipelines/compile-args";
import {
  issue,
  mapSource,
  newState,
  attempt,
} from "../pipelines/compile-state";
import type { CompileState, Segment } from "../pipelines/compile-state";
import { compileCondition, conditionData } from "../pipelines/condition-data";
import { AuthoringError, PipelineBuildError } from "../pipelines/errors";
import type { TargetData } from "../pipelines/model";
import { nodeOf, targetOf } from "../pipelines/registry";
import { rootPlaceholder, withOwners, withTracker } from "../pipelines/refs";
import { captureSite, type SourceSite } from "../pipelines/source";
import {
  automationTargetOf,
  markSubject,
  registerAutomationTarget,
  type AutomationTargetData,
} from "./targets";
import type {
  AutomationConfig,
  AutomationDefinition,
  AutomationTarget,
  EventOf,
  Rule,
  RuleOptions,
} from "./types";

type Json = Record<string, unknown>;

interface RouteData {
  when: ((r: object) => object) | undefined;
  target: object;
}

interface RuleData {
  event: AutomationEvent;
  match: "first" | "all" | undefined;
  routes: readonly RouteData[];
  otherwise: object | undefined;
  site: SourceSite | null;
}

const rules = new WeakMap<object, RuleData>();

const PROPERTY_SCHEMAS: Record<string, JsonSchema | undefined> = {
  title: { type: "string" },
  description: { type: ["string", "null"] },
  fields: undefined,
  labels: { type: "array", items: { type: "string" } },
  state: { type: "string", enum: ["open", "closed"] },
};

function eventWorkItem(subject: AutomationSubject, owner: object): object {
  const value: Record<string, unknown> = {};
  for (const [property, schema] of Object.entries(PROPERTY_SCHEMAS)) {
    Object.defineProperty(value, property, {
      get: () =>
        rootPlaceholder(`event.${subject}.${property}`, schema, { owner }),
      enumerable: true,
    });
  }
  return markSubject(value, subject);
}

/** The `r` for a rule's callbacks: placeholders over what the event carries. */
function eventContext(event: AutomationEvent): object {
  const context: Record<string, unknown> = {};
  context["workItem"] = eventWorkItem("workItem", context);
  if (eventHasChild(event)) {
    context["child"] = eventWorkItem("child", context);
  }
  if (event === "workItem.label.added") {
    Object.defineProperty(context, "label", {
      get: () =>
        rootPlaceholder("event.label", { type: "string" }, { owner: context }),
      enumerable: true,
    });
  }
  return context;
}

/** Does nothing: a route that matches and starts nothing. */
export const skip: AutomationTarget<AutomationScope> = registerAutomationTarget(
  { kind: "skip", site: null },
) as unknown as AutomationTarget<AutomationScope>;

/** Attaches another automation to the work item. Only in project automations. */
export function attach(
  automation: AutomationDefinition<"workItem">,
): AutomationTarget<"project"> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- JS callers
  if (automation?._tag !== "automation_document") {
    throw new AuthoringError(
      "attach(...) takes an automation: the value defineAutomation returns",
    );
  }
  return registerAutomationTarget({
    kind: "attach",
    automation: automation.key,
    site: captureSite(),
  }) as unknown as AutomationTarget<"project">;
}

/**
 * One rule: what to start when `event` happens, as one target (`to`) or as
 * routes chosen by conditions, like a pipeline's `.next(...)`.
 */
export function onEvent<const E extends AutomationEvent>(
  options: RuleOptions<E>,
): Rule<E> {
  const site = captureSite();
  const rule: RuleData =
    options.routes === undefined
      ? {
          event: options.event,
          match: undefined,
          routes: [{ when: undefined, target: options.to }],
          otherwise: undefined,
          site,
        }
      : {
          event: options.event,
          match: options.match,
          routes: options.routes.map((route) => ({
            when: route.when as RouteData["when"],
            target: route.to,
          })),
          otherwise: options.otherwise,
          site,
        };
  const value = Object.freeze({
    _tag: "automation_rule",
    event: options.event,
  });
  rules.set(value, rule);
  return value as unknown as Rule<E>;
}

function pipelineKeyOf(value: object): string | undefined {
  const tagged = value as { _tag?: unknown; key?: unknown };
  return tagged._tag === "pipeline_document" && typeof tagged.key === "string"
    ? tagged.key
    : undefined;
}

function resolveTarget(spec: object, context: object): AutomationTargetData {
  const handle = nodeOf(spec);
  if (handle?.kind === "step") {
    return {
      kind: "step",
      target: { node: handle, args: undefined, site: null },
      on: "workItem",
      site: null,
    };
  }
  const value =
    typeof spec === "function"
      ? (spec as (r: object) => object)(context)
      : spec;
  const automation = automationTargetOf(value);
  if (automation !== undefined) {
    return automation;
  }
  const target = targetOf(value);
  if (target?.node.kind === "step" && target.partial !== true) {
    return { kind: "step", target, on: "workItem", site: target.site };
  }
  const pipeline = pipelineKeyOf(value);
  if (pipeline !== undefined) {
    return { kind: "pipeline", pipeline, on: "workItem", site: null };
  }
  throw new AuthoringError(
    "this isn't an automation target: use a step call (step({ ... })), a pipeline, attach(automation) or skip",
  );
}

function compileArgs(
  state: CompileState,
  target: TargetData,
  pointer: readonly Segment[],
  owners: readonly object[],
): Record<string, ArgValue> | undefined {
  if (target.args === undefined) {
    return undefined;
  }
  const out: Record<string, ArgValue> = {};
  for (const [name, value] of argEntries(target.args)) {
    const compiled = attempt(state, [...pointer, name], target.site, () =>
      withOwners(owners, () => compileArg(name, value)),
    );
    if (compiled !== undefined) {
      out[name] = compiled;
    }
  }
  return out;
}

function compileTarget(
  state: CompileState,
  scope: AutomationScope,
  rule: RuleData,
  spec: object,
  context: object,
  pointer: readonly Segment[],
): Json | undefined {
  const target = attempt(state, pointer, rule.site, () =>
    withOwners([context], () => resolveTarget(spec, context)),
  );
  if (target === undefined) {
    return undefined;
  }
  mapSource(state, pointer, target.site ?? rule.site);
  const report = (message: string): void => {
    issue(state, target.site ?? rule.site, pointer, message);
  };
  if (
    (target.kind === "step" || target.kind === "pipeline") &&
    target.on === "child" &&
    !eventHasChild(rule.event)
  ) {
    report(
      `"${rule.event}" has no child work item; .on(r.child) only works on child.* events`,
    );
    return undefined;
  }
  switch (target.kind) {
    case "skip":
      return { kind: "skip" };
    case "attach":
      if (scope !== "project") {
        report(
          "only a project automation can attach automations; a work-item automation is attached to one work item",
        );
        return undefined;
      }
      return { kind: "attach", automation: target.automation };
    case "pipeline":
      return { kind: "pipeline", to: target.pipeline, on: target.on };
    case "step": {
      const args = compileArgs(
        state,
        target.target,
        [...pointer, "args"],
        [context],
      );
      const step =
        target.target.node.kind === "step" ? target.target.node.step : "";
      return {
        kind: "step",
        to: step,
        ...(args === undefined ? {} : { args }),
        on: target.on,
      };
    }
  }
}

function compileRule(
  state: CompileState,
  scope: AutomationScope,
  rule: RuleData,
  index: number,
): Json {
  const base: Segment[] = ["rules", index];
  mapSource(state, base, rule.site);
  if (scopeOfEvent(rule.event) !== scope) {
    issue(
      state,
      rule.site,
      [...base, "event"],
      `"${rule.event}" isn't an event of a ${scope === "workItem" ? "work-item" : "project"} automation`,
    );
  }
  const context = eventContext(rule.event);
  const route = (
    when: RouteData["when"],
    target: object,
    pointer: Segment[],
  ): Json => {
    const entry: Json = {};
    if (when !== undefined) {
      const compiled = attempt(state, [...pointer, "when"], rule.site, () =>
        withOwners([context], () =>
          compileCondition(conditionData(when(context))),
        ),
      );
      if (compiled !== undefined) {
        entry["when"] = compiled;
      }
    }
    return {
      ...entry,
      ...compileTarget(state, scope, rule, target, context, pointer),
    };
  };
  const next: Json = {};
  if (rule.match === "all") {
    next["match"] = "all";
  } else if (rule.routes.length > 1) {
    rule.routes.forEach((entry, routeIndex) => {
      if (entry.when === undefined) {
        issue(
          state,
          rule.site,
          [...base, "next", "routes", routeIndex],
          `rule ${String(index)} has more than one route, so in "first" mode every route needs a "when"; move this target to "otherwise", or use match: "all"`,
        );
      }
    });
  }
  next["routes"] = rule.routes.map((entry, routeIndex) =>
    route(entry.when, entry.target, [...base, "next", "routes", routeIndex]),
  );
  if (rule.otherwise !== undefined) {
    next["otherwise"] = route(undefined, rule.otherwise, [
      ...base,
      "next",
      "otherwise",
    ]);
  }
  return { event: rule.event, next };
}

/** Compiles an automation to its JSON document. Throws `PipelineBuildError`. */
export function defineAutomation<const S extends AutomationScope>(
  config: AutomationConfig<S>,
): AutomationDefinition<S> {
  const site = captureSite();
  const state = newState();
  const compiled = withTracker(state.tracker, () =>
    config.rules.map((value: Rule<EventOf<S>>, index) => {
      const rule = rules.get(value);
      if (rule === undefined) {
        issue(
          state,
          site,
          ["rules", index],
          "rules only take onEvent(...) rules",
        );
        return undefined;
      }
      return compileRule(state, config.scope, rule, index);
    }),
  );
  if (state.issues.length > 0) {
    throw new PipelineBuildError(config.key, state.issues);
  }
  const document = {
    kind: "automation",
    schemaVersion: 1,
    key: config.key,
    ...(config.title === undefined ? {} : { title: config.title }),
    scope: config.scope,
    rules: compiled,
  } as AutomationDocument;
  return {
    _tag: "automation_document",
    key: config.key,
    scope: config.scope,
    document,
    sourceMap: {
      "": site ?? { file: "<unknown>", line: 0, column: 0 },
      ...state.sourceMap,
    },
  };
}

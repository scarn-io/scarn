/**
 * `defineAutomation` and `onEvent`: runs each rule's callbacks once, with an
 * `r` of placeholders for the event, and compiles the rules to an automation
 * JSON document (format in `contracts/automation-document/schema.ts`). It
 * throws `PipelineBuildError` when a rule can't be compiled (including a
 * `schedule` rule's cron and timezone, checked as at publish); whether its
 * targets exist is checked when the automation is published.
 */
import {
  eventHasChild,
  RULE_KEY_PATTERN,
  scopeOfEvent,
  type AutomationDocument,
  type AutomationEvent,
  type AutomationScope,
} from "../contracts/automation-document";
import {
  issue,
  mapSource,
  newState,
  attempt,
} from "../pipelines/compile-state";
import type { CompileState, Segment } from "../pipelines/compile-state";
import { compileCondition, conditionData } from "../pipelines/condition-data";
import { AuthoringError, PipelineBuildError } from "../pipelines/errors";
import { nodeOf, targetOf } from "../pipelines/registry";
import { withOwners, withTracker } from "../pipelines/refs";
import { captureSite, type SourceSite } from "../pipelines/source";
import { compileSchedule, scheduleOptionsOf } from "./compile-schedule";
import { compileStep } from "./compile-step";
import { eventContext } from "./event-context";
import {
  automationTargetOf,
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
  ScheduleOptions,
} from "./types";

type Json = Record<string, unknown>;

interface RouteData {
  when: ((r: object) => object) | undefined;
  target: object;
}

interface RuleData {
  key: string;
  event: AutomationEvent;
  match: "first" | "all" | undefined;
  routes: readonly RouteData[];
  otherwise: object | undefined;
  schedule: ScheduleOptions | undefined;
  site: SourceSite | null;
}

const rules = new WeakMap<object, RuleData>();

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
  const schedule = scheduleOptionsOf(options);
  const rule: RuleData =
    options.routes === undefined
      ? {
          key: options.key,
          event: options.event,
          match: undefined,
          routes: [{ when: undefined, target: options.to }],
          otherwise: undefined,
          schedule,
          site,
        }
      : {
          key: options.key,
          event: options.event,
          match: options.match,
          routes: options.routes.map((route) => ({
            when: route.when as RouteData["when"],
            target: route.to,
          })),
          otherwise: options.otherwise,
          schedule,
          site,
        };
  const value = Object.freeze({
    _tag: "automation_rule",
    key: options.key,
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
      on: undefined,
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
    return { kind: "step", target, on: undefined, site: target.site };
  }
  const pipeline = pipelineKeyOf(value);
  if (pipeline !== undefined) {
    return { kind: "pipeline", pipeline, on: undefined, site: null };
  }
  throw new AuthoringError(
    "this isn't an automation target: use a step call (step({ ... })), a pipeline, attach(automation) or skip",
  );
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
  if (rule.event === "schedule") {
    return compileScheduleTarget(state, target, context, pointer, report);
  }
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
      return {
        kind: "pipeline",
        to: target.pipeline,
        on: target.on ?? "workItem",
      };
    case "step":
      return {
        ...compileStep(state, target, context, pointer),
        on: target.on ?? "workItem",
      };
  }
}

function compileScheduleTarget(
  state: CompileState,
  target: AutomationTargetData,
  context: object,
  pointer: readonly Segment[],
  report: (message: string) => void,
): Json | undefined {
  switch (target.kind) {
    case "skip":
      return { kind: "skip" };
    case "attach":
    case "pipeline":
      report(
        `a schedule rule can only start a step or skip; ${target.kind === "attach" ? "attach(...)" : "a pipeline"} needs a work item, so start a step that creates one instead`,
      );
      return undefined;
    case "step":
      if (target.on !== undefined) {
        report(
          "a schedule rule's step runs for no work item, so it takes no .on(...)",
        );
        return undefined;
      }
      return compileStep(state, target, context, pointer);
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
  return {
    key: rule.key,
    event: rule.event,
    ...compileSchedule(state, rule.event, rule.schedule, rule.site, base),
    next,
  };
}

function checkRuleKeys(
  state: CompileState,
  compiled: readonly (RuleData | undefined)[],
): void {
  const seen = new Set<string>();
  compiled.forEach((rule, index) => {
    if (rule === undefined) {
      return;
    }
    const pointer: Segment[] = ["rules", index, "key"];
    if (typeof rule.key !== "string" || !RULE_KEY_PATTERN.test(rule.key)) {
      issue(
        state,
        rule.site,
        pointer,
        `every rule needs a key of letters, digits, '_' and '-' (got ${JSON.stringify(rule.key)})`,
      );
      return;
    }
    if (seen.has(rule.key)) {
      issue(
        state,
        rule.site,
        pointer,
        `another rule already has the key "${rule.key}"; rule keys must be unique within an automation`,
      );
    }
    seen.add(rule.key);
  });
}

/** Compiles an automation to its JSON document. Throws `PipelineBuildError`. */
export function defineAutomation<const S extends AutomationScope>(
  config: AutomationConfig<S>,
): AutomationDefinition<S> {
  const site = captureSite();
  const state = newState();
  const ruleData = config.rules.map((value: Rule<EventOf<S>>) =>
    rules.get(value),
  );
  checkRuleKeys(state, ruleData);
  const compiled = withTracker(state.tracker, () =>
    ruleData.map((rule, index) => {
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

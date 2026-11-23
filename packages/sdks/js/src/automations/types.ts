/**
 * The public types of automations. An automation's `scope` picks the events
 * its rules may name, each event picks what `r` holds, and the scope picks
 * which targets a rule may start, so a rule that doesn't fit its automation
 * is a type error at the `onEvent(...)` call. A `schedule` rule has `cron`,
 * `timezone` and `concurrency`, an `r` of `r.schedule` refs, and starts only
 * steps or `skip`.
 */
import type {
  AutomationDocument,
  AutomationScope,
  AutomationSubject,
  ProjectAutomationEvent,
  ScheduleConcurrency,
  WorkItemAutomationEvent,
} from "../contracts/automation-document";
import type { StepRef } from "../definitions/steps/step-ref";
import type { Condition } from "../pipelines/condition-data";
import type { PipelineDefinition } from "../pipelines/define-pipeline";
import type { Placeholder, UntypedPlaceholder } from "../pipelines/ref-types";
import type { SourceSite } from "../pipelines/source";
import type { StepTarget, targetBrand } from "../pipelines/types";

export declare const subjectBrand: unique symbol;
export declare const automationTargetBrand: unique symbol;
export declare const ruleBrand: unique symbol;

export type ChildEvent = Extract<WorkItemAutomationEvent, `child.${string}`>;

/** The events an automation of scope `S` reacts to. */
export type EventOf<S extends AutomationScope> = S extends "workItem"
  ? WorkItemAutomationEvent
  : ProjectAutomationEvent;

/** The scope whose automations react to `E`. */
export type ScopeOf<E> = E extends WorkItemAutomationEvent
  ? "workItem"
  : "project";

/**
 * A work item an event is about: `r.workItem` or `r.child`. Its properties
 * are refs, and passing it to `.on(...)` starts the target for it.
 */
export interface EventWorkItem<K extends AutomationSubject> {
  readonly [subjectBrand]: K;
  readonly title: Placeholder<string>;
  readonly description: Placeholder<string | null>;
  /** The work item's form fields, by name. */
  readonly fields: UntypedPlaceholder;
  readonly labels: Placeholder<string[]>;
  readonly state: Placeholder<"open" | "closed">;
}

type NoKeys = Record<never, never>;

/** `r.schedule` on a `schedule` rule: refs to the run's schedule. */
export interface EventSchedule {
  /** The rule's key. */
  readonly key: Placeholder<string>;
  /**
   * The cron time this run is for (an ISO date-time): the latest due time
   * when missed ticks collapse, not the wall-clock time of the tick.
   */
  readonly scheduledFor: Placeholder<string>;
  /**
   * `scheduledFor` of the schedule's most recent succeeded run, or null
   * before the first one. Only advances on success, so a failed or skipped
   * run widens the next run's window.
   */
  readonly previousScheduledFor: Placeholder<string | null>;
  /** The IANA timezone the cron is read in. */
  readonly timezone: Placeholder<string>;
}

/** `r` in a rule's callbacks: what the event `E` carries. */
export type EventContext<E> = E extends "schedule"
  ? {
      /** The schedule this run is for. A schedule rule is about no work item. */
      readonly schedule: EventSchedule;
    }
  : WorkItemEventContext<E>;

type WorkItemEventContext<E> = {
  /** The work item the rule is about. */
  readonly workItem: EventWorkItem<"workItem">;
} & (E extends ChildEvent
  ? {
      /** The child work item the event happened to. */
      readonly child: EventWorkItem<"child">;
    }
  : NoKeys) &
  (E extends "workItem.label.added"
    ? {
        /** The label that was added. */
        readonly label: Placeholder<string>;
      }
    : NoKeys);

/**
 * Something a rule starts, usable in automations of scope `S`: the brand is
 * a function of the scope, so a target for any scope fits both, and an
 * `attach(...)` (project only) doesn't fit a work-item automation.
 */
export interface AutomationTarget<S extends AutomationScope> {
  readonly [automationTargetBrand]: (scope: S) => void;
}

/** A pipeline started from a rule: for `r.workItem` unless `.on(...)` says otherwise. */
export interface PipelineCall extends AutomationTarget<AutomationScope> {
  /** Starts the pipeline run for `workItem` (`r.workItem` or `r.child`). */
  on(
    workItem: EventWorkItem<AutomationSubject>,
  ): AutomationTarget<AutomationScope>;
}

/** A step handle whose input has no required keys, used without calling it. */
export type BareStep = { readonly [targetBrand]: true } & StepRef<
  unknown,
  unknown
>;

/** What a rule of scope `S` may start. */
export type RuleTarget<S extends AutomationScope> =
  AutomationTarget<S> | StepTarget | BareStep | PipelineDefinition;

/**
 * What a `schedule` rule may start: a step (for no work item, so without
 * `.on(...)`) or `skip`. Pipelines and `attach` need a work item.
 */
export type ScheduleRuleTarget =
  AutomationTarget<AutomationScope> | StepTarget | BareStep;

type TargetOfEvent<E> = E extends "schedule"
  ? ScheduleRuleTarget
  : RuleTarget<ScopeOf<E>>;

/** A target, or a callback receiving `r` that returns one. */
export type RuleTargetArg<E> =
  TargetOfEvent<E> | ((r: EventContext<E>) => TargetOfEvent<E>);

/** The settings only a `schedule` rule has. */
export interface ScheduleOptions {
  /**
   * When the rule fires: 5-field cron (`"*\/15 * * * *"`) or an alias such
   * as `"@hourly"` or `"@daily"`. No seconds field and no Quartz syntax.
   */
  cron: string;
  /** IANA timezone `cron` is read in. Defaults to `"UTC"`. */
  timezone?: string;
  /**
   * How many runs of the schedule may be open at once. Defaults to
   * `{ max: 1, waiting: 0 }`: a tick is skipped while a run is open.
   */
  concurrency?: ScheduleConcurrency;
}

type ScheduleFields<E> = E extends "schedule"
  ? ScheduleOptions
  : { cron?: never; timezone?: never; concurrency?: never };

/** One route of a rule: taken when `when` matches (or always, with no `when`). */
export interface RuleRoute<E> {
  when?: (r: EventContext<E>) => Condition;
  to: RuleTargetArg<E>;
}

/** A rule that starts one target whenever its event happens. */
export interface RuleToOptions<E> {
  /** The rule's name, unique within its automation: letters, digits, `_` and `-`. */
  key: string;
  event: E;
  to: RuleTargetArg<E>;
  routes?: never;
  match?: never;
  otherwise?: never;
}

/**
 * A rule with routes, like a pipeline's `.next({ routes })`: in `"first"`
 * mode (the default) the first matching route is taken, in `"all"` mode
 * every matching route is.
 */
export interface RuleRoutesOptions<E> {
  /** The rule's name, unique within its automation: letters, digits, `_` and `-`. */
  key: string;
  event: E;
  to?: never;
  match?: "first" | "all";
  routes: readonly [RuleRoute<E>, ...RuleRoute<E>[]];
  /** Taken when no route with a `when` matched. */
  otherwise?: RuleTargetArg<E>;
}

export type RuleOptions<E> = (RuleToOptions<E> | RuleRoutesOptions<E>) &
  ScheduleFields<E>;

/** A finished rule, from `onEvent(...)`, for an automation's `rules`. */
export interface Rule<E> {
  readonly [ruleBrand]: true;
  readonly key: string;
  readonly event: E;
}

export interface AutomationConfig<S extends AutomationScope> {
  key: string;
  title?: string;
  /** `"workItem"`: attached to one work item. `"project"`: enabled for a whole project. */
  scope: S;
  rules: readonly Rule<EventOf<S>>[];
}

/** What `defineAutomation` returns: the compiled document and its source sites. */
export interface AutomationDefinition<
  S extends AutomationScope = AutomationScope,
> {
  readonly _tag: "automation_document";
  readonly key: string;
  readonly scope: S;
  readonly document: AutomationDocument;
  /** TS source sites by JSON pointer (`/rules/1/next/routes/0`), for error messages. */
  readonly sourceMap: Readonly<Record<string, SourceSite>>;
}

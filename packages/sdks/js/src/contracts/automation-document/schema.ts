/**
 * The zod schema for automation JSON documents (schema version 1): what
 * `defineAutomation` compiles to and `scarn pipelines build` writes as
 * `<key>.json`, next to the pipeline documents.
 *
 * ```json
 * {
 *   "kind": "automation",
 *   "schemaVersion": 1,
 *   "key": "wayfinder",
 *   "title": "Wayfinder",
 *   "scope": "workItem",
 *   "rules": [
 *     {
 *       "key": "research",
 *       "event": "child.ready",
 *       "next": {
 *         "routes": [
 *           {
 *             "when": { "path": "event.child.labels", "op": "contains", "value": "wayfinder:research" },
 *             "kind": "step",
 *             "to": "research",
 *             "args": { "question": "event.child.title" },
 *             "on": "child"
 *           }
 *         ],
 *         "otherwise": { "kind": "skip" }
 *       }
 *     }
 *   ]
 * }
 * ```
 *
 * - Every rule has a `key` (letters, digits, `_` and `-`), unique within the
 *   automation.
 * - `scope` limits `event`: work-item automations react to `self.attached`
 *   and `child.*`, project automations to `workItem.*` and `schedule`.
 * - A `schedule` rule also has `cron` (5 fields or an `@` alias, see
 *   `cron.ts`), an optional IANA `timezone` (default `UTC`) and an optional
 *   `concurrency` (`{ max, waiting }`, default `{ max: 1, waiting: 0 }`).
 * - `next` has the shape of a pipeline node's `next`: `match` (`"first"`, the
 *   default, or `"all"`), `routes`, each with an optional `when`, and
 *   `otherwise`. A rule with one target compiles to one route without `when`.
 * - Each route is a target: `step` (a step key, with args) or `pipeline` (a
 *   pipeline key), each started for the work item `on` names (`"workItem"`,
 *   the one the rule is about, or `"child"`, only on `child.*` events);
 *   `attach` (another automation's key, project scope only); or `skip`.
 *   `schedule` rules are about no work item: they only start steps, without
 *   `on`, or skip.
 * - Refs in `when` and `args` read the event: `event.workItem.<prop>`,
 *   `event.child.<prop>` (on `child.*` events) and `event.label` (on
 *   `workItem.label.added`), where `<prop>` is `title`, `description`,
 *   `labels`, `state` or `fields.<name>`; on `schedule`, only
 *   `event.schedule.key`, `.scheduledFor`, `.previousScheduledFor` and
 *   `.timezone`. Args use the pipeline arg format (a ref string,
 *   `{ "value": ... }` or `{ "list": [...] }`).
 *
 * The schema checks structure and that events fit the scope. Whether `to`
 * names a known step or pipeline, and whether args fit its input, is checked
 * when the automation is published.
 */
import { z } from "zod";
import {
  argValueSchema,
  conditionSchema,
  MATCH_MODES,
  NODE_ID_PATTERN,
} from "../pipeline-document/schema";
import {
  cronExpressionError,
  DEFAULT_SCHEDULE_TIMEZONE,
  timezoneError,
} from "./cron";

export const AUTOMATION_SCOPES = ["workItem", "project"] as const;

/** Events of a work-item automation: about its own work item and its child work items. */
export const WORK_ITEM_AUTOMATION_EVENTS = [
  "self.attached",
  "child.created",
  "child.ready",
  "child.closed",
] as const;

/**
 * Events of a project automation: about any top-level work item in the
 * project, and `schedule`, which is about no work item.
 */
export const PROJECT_AUTOMATION_EVENTS = [
  "workItem.created",
  "workItem.ready",
  "workItem.label.added",
  "schedule",
] as const;

export const AUTOMATION_EVENTS = [
  ...WORK_ITEM_AUTOMATION_EVENTS,
  ...PROJECT_AUTOMATION_EVENTS,
] as const;

/** Events about a work item: every event but `schedule`. */
export const WORK_ITEM_EVENTS = [
  ...WORK_ITEM_AUTOMATION_EVENTS,
  "workItem.created",
  "workItem.ready",
  "workItem.label.added",
] as const satisfies readonly AutomationEvent[];

/** Which work item a started Task or pipeline run is for. */
export const AUTOMATION_SUBJECTS = ["workItem", "child"] as const;

export type AutomationScope = (typeof AUTOMATION_SCOPES)[number];
export type WorkItemAutomationEvent =
  (typeof WORK_ITEM_AUTOMATION_EVENTS)[number];
export type ProjectAutomationEvent = (typeof PROJECT_AUTOMATION_EVENTS)[number];
export type AutomationEvent = (typeof AUTOMATION_EVENTS)[number];
export type WorkItemEvent = (typeof WORK_ITEM_EVENTS)[number];
export type AutomationSubject = (typeof AUTOMATION_SUBJECTS)[number];

/** The scope whose automations react to `event`. */
export function scopeOfEvent(event: AutomationEvent): AutomationScope {
  return (WORK_ITEM_AUTOMATION_EVENTS as readonly string[]).includes(event)
    ? "workItem"
    : "project";
}

/** Whether `event` has a `child` work item. */
export function eventHasChild(event: AutomationEvent): boolean {
  return event.startsWith("child.");
}

/** Whether `event` is about a work item, so its targets start for one (`on`). */
export function eventHasWorkItem(event: AutomationEvent): boolean {
  return event !== "schedule";
}

const keySchema = z.string().min(1);
const subjectSchema = z.enum(AUTOMATION_SUBJECTS);

const stepTargetShape = {
  kind: z.literal("step"),
  to: keySchema,
  args: z.record(z.string().min(1), argValueSchema).optional(),
  /** Required on events about a work item; left out on `schedule` rules. */
  on: subjectSchema.optional(),
};

const pipelineTargetShape = {
  kind: z.literal("pipeline"),
  to: keySchema,
  on: subjectSchema,
};

const attachTargetShape = {
  kind: z.literal("attach"),
  automation: keySchema,
};

const skipTargetShape = { kind: z.literal("skip") };

/** What a rule starts: a step's Task, a pipeline run, an attachment, or nothing. */
export const automationTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject(stepTargetShape),
  z.strictObject(pipelineTargetShape),
  z.strictObject(attachTargetShape),
  z.strictObject(skipTargetShape),
]);

const when = { when: conditionSchema.optional() };

/** One route: an optional `when`, then the target's keys. */
export const automationRouteSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...when, ...stepTargetShape }),
  z.strictObject({ ...when, ...pipelineTargetShape }),
  z.strictObject({ ...when, ...attachTargetShape }),
  z.strictObject({ ...when, ...skipTargetShape }),
]);

export const automationNextSchema = z.strictObject({
  match: z.enum(MATCH_MODES).optional(),
  routes: z.array(automationRouteSchema).min(1),
  otherwise: automationTargetSchema.optional(),
});

export const RULE_KEY_PATTERN = NODE_ID_PATTERN;

const ruleKeySchema = z
  .string()
  .regex(
    RULE_KEY_PATTERN,
    "Rule keys may only contain letters, digits, '_' and '-'",
  );

/**
 * How many runs of one schedule may be open at once: `max` running and up
 * to `waiting` more waiting for a slot. A tick that finds the group full is
 * skipped.
 */
export const scheduleConcurrencySchema = z.strictObject({
  max: z.number().int().min(1),
  waiting: z.number().int().min(0),
});

export type ScheduleConcurrency = z.infer<typeof scheduleConcurrencySchema>;

/** Skip a tick while a run of the schedule is still open. */
export const DEFAULT_SCHEDULE_CONCURRENCY: ScheduleConcurrency = {
  max: 1,
  waiting: 0,
};

const cronSchema = z.string().superRefine((cron, ctx) => {
  const error = cronExpressionError(cron);
  if (error !== null) {
    ctx.addIssue({ code: "custom", message: error });
  }
});

const timezoneSchema = z.string().superRefine((timezone, ctx) => {
  const error = timezoneError(timezone);
  if (error !== null) {
    ctx.addIssue({ code: "custom", message: error });
  }
});

const eventRuleSchema = z.strictObject({
  key: ruleKeySchema,
  event: z.enum(WORK_ITEM_EVENTS),
  next: automationNextSchema,
});

/** A `schedule` rule: starts its step whenever `cron` matches in `timezone`. */
export const scheduleRuleSchema = z.strictObject({
  key: ruleKeySchema,
  event: z.literal("schedule"),
  cron: cronSchema,
  /** IANA timezone `cron` is read in; defaults to UTC. */
  timezone: timezoneSchema.optional(),
  /** Defaults to {@link DEFAULT_SCHEDULE_CONCURRENCY}. */
  concurrency: scheduleConcurrencySchema.optional(),
  next: automationNextSchema,
});

export const automationRuleSchema = z.discriminatedUnion("event", [
  eventRuleSchema,
  scheduleRuleSchema,
]);

export type ScheduleRule = z.infer<typeof scheduleRuleSchema>;

/** A schedule rule's settings with defaults filled in. */
export interface ScheduleSettings {
  key: string;
  cron: string;
  timezone: string;
  concurrency: ScheduleConcurrency;
}

export function scheduleSettingsOf(rule: ScheduleRule): ScheduleSettings {
  return {
    key: rule.key,
    cron: rule.cron,
    timezone: rule.timezone ?? DEFAULT_SCHEDULE_TIMEZONE,
    concurrency: rule.concurrency ?? DEFAULT_SCHEDULE_CONCURRENCY,
  };
}

/** The settings of every `schedule` rule in `document`, in rule order. */
export function schedulesOf(document: AutomationDocument): ScheduleSettings[] {
  return document.rules
    .filter((rule): rule is ScheduleRule => rule.event === "schedule")
    .map(scheduleSettingsOf);
}

type Target = z.infer<typeof automationTargetSchema>;

function targetsOf(
  rule: z.infer<typeof automationRuleSchema>,
): { target: Target; path: (string | number)[] }[] {
  return [
    ...rule.next.routes.map((target, index) => ({
      target,
      path: ["routes", index],
    })),
    ...(rule.next.otherwise === undefined
      ? []
      : [{ target: rule.next.otherwise, path: ["otherwise"] }]),
  ];
}

export const automationDocumentSchema = z
  .strictObject({
    $schema: z.string().optional(),
    kind: z.literal("automation"),
    schemaVersion: z.literal(1),
    key: keySchema,
    title: z.string().optional(),
    scope: z.enum(AUTOMATION_SCOPES),
    rules: z.array(automationRuleSchema),
  })
  .superRefine((document, ctx) => {
    const seenKeys = new Set<string>();
    document.rules.forEach((rule, index) => {
      if (seenKeys.has(rule.key)) {
        ctx.addIssue({
          code: "custom",
          message: `Another rule already has the key "${rule.key}"; rule keys must be unique within an automation`,
          path: ["rules", index, "key"],
        });
      }
      seenKeys.add(rule.key);
      if (scopeOfEvent(rule.event) !== document.scope) {
        ctx.addIssue({
          code: "custom",
          message: `"${rule.event}" isn't an event of a ${document.scope === "workItem" ? "work-item" : "project"} automation`,
          path: ["rules", index, "event"],
        });
      }
      for (const { target, path } of targetsOf(rule)) {
        const at = ["rules", index, "next", ...path];
        if (rule.event === "schedule") {
          if (target.kind === "pipeline" || target.kind === "attach") {
            ctx.addIssue({
              code: "custom",
              message: `A schedule rule can only start a step or skip; "${target.kind}" needs a work item, so start a step that creates one instead`,
              path: [...at, "kind"],
            });
          }
          if (target.kind === "step" && target.on !== undefined) {
            ctx.addIssue({
              code: "custom",
              message:
                'A schedule rule\'s step runs for no work item, so it has no "on"',
              path: [...at, "on"],
            });
          }
          continue;
        }
        if (target.kind === "attach" && document.scope !== "project") {
          ctx.addIssue({
            code: "custom",
            message: "Only a project automation can attach automations",
            path: ["rules", index, "next"],
          });
        }
        if (target.kind === "step" && target.on === undefined) {
          ctx.addIssue({
            code: "custom",
            message: `A step target needs "on": "workItem"${eventHasChild(rule.event) ? ' or "child"' : ""}`,
            path: [...at, "on"],
          });
        }
        if (
          (target.kind === "step" || target.kind === "pipeline") &&
          target.on === "child" &&
          !eventHasChild(rule.event)
        ) {
          ctx.addIssue({
            code: "custom",
            message: `"${rule.event}" has no child work item, so a target can't be "on": "child"`,
            path: ["rules", index, "next"],
          });
        }
      }
    });
  });

export type AutomationTargetJson = Target;
export type AutomationRoute = z.infer<typeof automationRouteSchema>;
export type AutomationNext = z.infer<typeof automationNextSchema>;
export type AutomationRule = z.infer<typeof automationRuleSchema>;
export type AutomationDocument = z.infer<typeof automationDocumentSchema>;

/** The JSON Schema for automation documents, for editors and external tools. */
export function automationDocumentJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(automationDocumentSchema, { io: "input" });
}

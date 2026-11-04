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
 * - `scope` limits `event`: work-item automations react to `self.attached`
 *   and `child.*`, project automations to `workItem.*`.
 * - `next` has the shape of a pipeline node's `next`: `match` (`"first"`, the
 *   default, or `"all"`), `routes`, each with an optional `when`, and
 *   `otherwise`. A rule with one target compiles to one route without `when`.
 * - Each route is a target: `step` (a step key, with args) or `pipeline` (a
 *   pipeline key), each started for the work item `on` names (`"workItem"`,
 *   the one the rule is about, or `"child"`, only on `child.*` events);
 *   `attach` (another automation's key, project scope only); or `skip`.
 * - Refs in `when` and `args` read the event: `event.workItem.<prop>`,
 *   `event.child.<prop>` (on `child.*` events) and `event.label` (on
 *   `workItem.label.added`), where `<prop>` is `title`, `description`,
 *   `labels`, `state` or `fields.<name>`. Args use the pipeline arg format
 *   (a ref string, `{ "value": ... }` or `{ "list": [...] }`).
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
} from "../pipeline-document/schema";

export const AUTOMATION_SCOPES = ["workItem", "project"] as const;

/** Events of a work-item automation: about its own work item and its child work items. */
export const WORK_ITEM_AUTOMATION_EVENTS = [
  "self.attached",
  "child.created",
  "child.ready",
  "child.closed",
] as const;

/** Events of a project automation: about any top-level work item in the project. */
export const PROJECT_AUTOMATION_EVENTS = [
  "workItem.created",
  "workItem.ready",
  "workItem.label.added",
] as const;

export const AUTOMATION_EVENTS = [
  ...WORK_ITEM_AUTOMATION_EVENTS,
  ...PROJECT_AUTOMATION_EVENTS,
] as const;

/** Which work item a started Task or pipeline run is for. */
export const AUTOMATION_SUBJECTS = ["workItem", "child"] as const;

export type AutomationScope = (typeof AUTOMATION_SCOPES)[number];
export type WorkItemAutomationEvent =
  (typeof WORK_ITEM_AUTOMATION_EVENTS)[number];
export type ProjectAutomationEvent = (typeof PROJECT_AUTOMATION_EVENTS)[number];
export type AutomationEvent = (typeof AUTOMATION_EVENTS)[number];
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

const keySchema = z.string().min(1);
const subjectSchema = z.enum(AUTOMATION_SUBJECTS);

const stepTargetShape = {
  kind: z.literal("step"),
  to: keySchema,
  args: z.record(z.string().min(1), argValueSchema).optional(),
  on: subjectSchema,
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

export const automationRuleSchema = z.strictObject({
  event: z.enum(AUTOMATION_EVENTS),
  next: automationNextSchema,
});

type Target = z.infer<typeof automationTargetSchema>;

function targetsOf(rule: z.infer<typeof automationRuleSchema>): Target[] {
  return [
    ...rule.next.routes,
    ...(rule.next.otherwise === undefined ? [] : [rule.next.otherwise]),
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
    document.rules.forEach((rule, index) => {
      if (scopeOfEvent(rule.event) !== document.scope) {
        ctx.addIssue({
          code: "custom",
          message: `"${rule.event}" isn't an event of a ${document.scope === "workItem" ? "work-item" : "project"} automation`,
          path: ["rules", index, "event"],
        });
      }
      for (const target of targetsOf(rule)) {
        if (target.kind === "attach" && document.scope !== "project") {
          ctx.addIssue({
            code: "custom",
            message: "Only a project automation can attach automations",
            path: ["rules", index, "next"],
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

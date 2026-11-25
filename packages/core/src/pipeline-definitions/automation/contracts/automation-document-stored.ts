import { z } from "zod";
import type { AutomationDocument } from "@scarn/sdk/contracts/automation-document";
import type {
  ArgValue,
  Condition,
} from "@scarn/sdk/contracts/pipeline-document";
import { createStoredReader } from "@scarn/core/lib/db/stored-json";

/**
 * Read-side schemas for `automation_versions.document`, one per
 * `schema_version`. Structural only: unknown keys are stripped and publish
 * rules (rule key format and uniqueness, scope/event fit, cron and timezone
 * syntax, condition grammar) are not re-applied, so tightening the SDK's
 * `automationDocumentSchema` never makes a stored version unreadable. Each
 * version's shape is frozen here rather than imported from the SDK. A
 * breaking change to the stored shape adds a new version, a stored schema
 * for it, a `vN → vN+1` converter and a fixture under
 * `tests/pipeline-definitions/automation/fixtures/`. See
 * `docs/persistence/json-columns.md`.
 */

const storedObjectSchema = z.looseObject({});

const storedConditionSchema = z.custom<Condition>(
  (value) => storedObjectSchema.safeParse(value).success,
);
const storedArgValueSchema = z.custom<ArgValue>(
  (value) =>
    typeof value === "string" || storedObjectSchema.safeParse(value).success,
);

const storedSubjectSchema = z.enum(["workItem", "child"]);

const stepTargetShape = {
  kind: z.literal("step"),
  to: z.string(),
  args: z.record(z.string(), storedArgValueSchema).optional(),
  on: storedSubjectSchema.optional(),
};
const pipelineTargetShape = {
  kind: z.literal("pipeline"),
  to: z.string(),
  on: storedSubjectSchema,
};
const attachTargetShape = { kind: z.literal("attach"), automation: z.string() };
const skipTargetShape = { kind: z.literal("skip") };

const when = { when: storedConditionSchema.optional() };

const storedTargetV1Schema = z.discriminatedUnion("kind", [
  z.object(stepTargetShape),
  z.object(pipelineTargetShape),
  z.object(attachTargetShape),
  z.object(skipTargetShape),
]);

const storedRouteV1Schema = z.discriminatedUnion("kind", [
  z.object({ ...when, ...stepTargetShape }),
  z.object({ ...when, ...pipelineTargetShape }),
  z.object({ ...when, ...attachTargetShape }),
  z.object({ ...when, ...skipTargetShape }),
]);

const storedNextV1Schema = z.object({
  match: z.enum(["first", "all"]).optional(),
  routes: z.array(storedRouteV1Schema),
  otherwise: storedTargetV1Schema.optional(),
});

/** Rules published before rule keys were required have none; see {@link defaultRuleKey}. */
const storedRuleKeySchema = z.string().optional();

const storedRuleV1Schema = z.discriminatedUnion("event", [
  z.object({
    key: storedRuleKeySchema,
    event: z.enum([
      "self.attached",
      "child.created",
      "child.ready",
      "child.closed",
      "workItem.created",
      "workItem.ready",
      "workItem.label.added",
    ]),
    next: storedNextV1Schema,
  }),
  z.object({
    key: storedRuleKeySchema,
    event: z.literal("schedule"),
    cron: z.string(),
    timezone: z.string().optional(),
    concurrency: z.object({ max: z.number(), waiting: z.number() }).optional(),
    next: storedNextV1Schema,
  }),
]);

/**
 * The key given to a stored rule that has none: `rule-<n>`, 1-based. The
 * `backfill_automation_rule_keys` migration writes the same keys.
 */
export const defaultRuleKey = (index: number): string =>
  `rule-${String(index + 1)}`;

export const storedAutomationDocumentV1Schema = z
  .object({
    $schema: z.string().optional(),
    kind: z.literal("automation"),
    schemaVersion: z.literal(1),
    key: z.string(),
    title: z.string().optional(),
    scope: z.enum(["workItem", "project"]),
    rules: z.array(storedRuleV1Schema),
  })
  .transform((document): AutomationDocument => ({
    ...document,
    rules: document.rules.map((rule, index) => ({
      ...rule,
      key: rule.key ?? defaultRuleKey(index),
    })),
  }));

export const CURRENT_AUTOMATION_DOCUMENT_SCHEMA_VERSION = 1;

/** The JSON column of an `automation_versions` row, as read. */
export type StoredAutomationVersionColumns = { document: unknown };

/**
 * Reads a version's `document` at `schemaVersion` into the current shape,
 * or explains why it is unreadable.
 */
export const readStoredAutomationDocument = createStoredReader<
  StoredAutomationVersionColumns,
  AutomationDocument,
  1
>({
  current: CURRENT_AUTOMATION_DOCUMENT_SCHEMA_VERSION,
  byVersion: {
    1: (columns) =>
      storedAutomationDocumentV1Schema.safeParse(columns.document),
  },
});

import { anyJsonObjectSchema } from "@scarn/core/common/contracts/json";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { taskStatusValues } from "@scarn/core/tasks/task/domain/task-entity";
import { workItemIdSchema } from "@scarn/core/work-items/work-item/contracts/work-item-contracts";
import { AUTOMATION_SCOPES } from "@scarn/sdk/contracts/automation-document";
import { z } from "zod";

const automationKeySchema = z.string().trim().min(1);

export const automationVersionSchema = z.object({
  id: uuidV7Schema,
  version: z.number().int().positive(),
  schemaVersion: z.number().int().positive(),
  contentHash: z.string().min(1),
  document: anyJsonObjectSchema,
  publishedAt: z.iso.datetime(),
});

/** A live `schedule` rule of a project automation and how its runs went. */
export const automationScheduleSummarySchema = z.object({
  id: uuidV7Schema,
  /** The rule key. */
  key: z.string(),
  cron: z.string(),
  timezone: z.string(),
  concurrency: z.object({
    max: z.number().int().positive(),
    waiting: z.number().int().nonnegative(),
  }),
  /** When the tick fires it next; `null` while the automation is disabled. */
  nextRunAt: z.iso.datetime().nullable(),
  /** When the tick or Run now last started (or routed) a run. */
  lastFiredAt: z.iso.datetime().nullable(),
  /** The scheduled Task with the latest `scheduledFor`. */
  lastTask: z
    .object({
      id: uuidV7Schema,
      status: z.enum(taskStatusValues),
      scheduledFor: z.iso.datetime(),
    })
    .nullable(),
  /**
   * Failed Tasks since the latest succeeded one; cancelled Tasks neither
   * count nor break the streak.
   */
  failureStreak: z.number().int().nonnegative(),
  /** When a fire last found the concurrency group full. */
  lastSkippedAt: z.iso.datetime().nullable(),
  /** Skips since the last fire. */
  skippedCountSinceFire: z.number().int().nonnegative(),
  /** The last time a fire failed to start a run, and why. */
  lastError: z.object({ message: z.string(), at: z.iso.datetime() }).nullable(),
});

export const automationSchema = z.object({
  id: uuidV7Schema,
  projectId: uuidV7Schema,
  key: automationKeySchema,
  title: z.string().nullable(),
  scope: z.enum(AUTOMATION_SCOPES),
  /** Only meaningful for project automations; always false for work-item ones. */
  enabled: z.boolean(),
  /** The version that runs. */
  latestVersion: automationVersionSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** A project automation as the automations list shows it, with its live schedule rules in key order. */
export const automationListItemSchema = automationSchema.extend({
  schedules: z.array(automationScheduleSummarySchema),
});

export const workItemAutomationSchema = z.object({
  workItemId: workItemIdSchema,
  automation: automationSchema,
  attachedByUserId: uuidV7Schema,
  attachedAt: z.iso.datetime(),
});

export const automationRefInputSchema = z.object({
  projectId: uuidV7Schema,
  key: automationKeySchema,
});

export const publishAutomationInputSchema = automationRefInputSchema.extend({
  document: anyJsonObjectSchema,
});

/** `published: false` when the document matched the latest version. */
export const publishAutomationResultSchema = z.object({
  published: z.boolean(),
  automation: automationSchema,
});

export const setAutomationEnabledInputSchema = automationRefInputSchema.extend({
  enabled: z.boolean(),
});

export const runAutomationScheduleInputSchema = automationRefInputSchema.extend(
  { ruleKey: automationKeySchema },
);

/** A Run now: `taskId` is null when the rule routed to `skip` or to nothing. */
export const runAutomationScheduleResultSchema = z.object({
  taskId: uuidV7Schema.nullable(),
  scheduledFor: z.iso.datetime(),
});

export const workItemAutomationRefInputSchema = z.object({
  workItemId: workItemIdSchema,
  key: automationKeySchema,
});

export type AutomationVersionContract = z.infer<typeof automationVersionSchema>;
export type AutomationContract = z.infer<typeof automationSchema>;
export type AutomationScheduleSummaryContract = z.infer<
  typeof automationScheduleSummarySchema
>;
export type AutomationListItemContract = z.infer<
  typeof automationListItemSchema
>;
export type WorkItemAutomationContract = z.infer<
  typeof workItemAutomationSchema
>;
export type AutomationRefInput = z.input<typeof automationRefInputSchema>;
export type PublishAutomationInput = z.input<
  typeof publishAutomationInputSchema
>;
export type PublishAutomationResult = z.infer<
  typeof publishAutomationResultSchema
>;
export type SetAutomationEnabledInput = z.input<
  typeof setAutomationEnabledInputSchema
>;
export type RunAutomationScheduleInput = z.input<
  typeof runAutomationScheduleInputSchema
>;
export type RunAutomationScheduleResult = z.infer<
  typeof runAutomationScheduleResultSchema
>;
export type WorkItemAutomationRefInput = z.input<
  typeof workItemAutomationRefInputSchema
>;

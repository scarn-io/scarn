import { anyJsonObjectSchema } from "@scarn/core/common/contracts/json";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
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

export const workItemAutomationRefInputSchema = z.object({
  workItemId: workItemIdSchema,
  key: automationKeySchema,
});

export type AutomationVersionContract = z.infer<typeof automationVersionSchema>;
export type AutomationContract = z.infer<typeof automationSchema>;
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
export type WorkItemAutomationRefInput = z.input<
  typeof workItemAutomationRefInputSchema
>;

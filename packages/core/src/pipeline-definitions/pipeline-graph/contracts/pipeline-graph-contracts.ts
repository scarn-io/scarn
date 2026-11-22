import { anyJsonObjectSchema } from "@scarn/core/common/contracts/json";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { z } from "zod";

const nonEmptyStringSchema = z.string().trim().min(1);

export const pinnedStepSchema = z.object({
  stepKey: nonEmptyStringSchema,
  stepDefinitionId: uuidV7Schema,
});

/** One published version: the validated document and the step versions it pinned. */
export const pipelineVersionSchema = z.object({
  id: uuidV7Schema,
  pipelineDefinitionId: uuidV7Schema,
  version: z.number().int().positive(),
  schemaVersion: z.number().int().positive(),
  contentHash: nonEmptyStringSchema,
  definition: anyJsonObjectSchema,
  steps: z.array(pinnedStepSchema),
  createdAt: z.iso.datetime(),
});

export const pipelineVersionSummarySchema = pipelineVersionSchema.omit({
  definition: true,
  steps: true,
});

export const pipelineDefinitionSchema = z.object({
  id: uuidV7Schema,
  projectId: uuidV7Schema,
  key: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  archivedAt: z.iso.datetime().nullable(),
  /** The active version: new runs start on it. */
  currentVersion: pipelineVersionSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const createPipelineDefinitionInputSchema = z.object({
  projectId: uuidV7Schema,
  key: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  /** Published as version 1 when present. */
  document: anyJsonObjectSchema.optional(),
});

export const publishPipelineVersionInputSchema = z.object({
  pipelineDefinitionId: uuidV7Schema,
  document: anyJsonObjectSchema,
});

export const pipelineVersionRefInputSchema = z.object({
  pipelineDefinitionId: uuidV7Schema,
  version: z.number().int().positive(),
});

export const getPipelineDefinitionInputSchema = uuidV7Schema;
export const listPipelineDefinitionsByProjectIdInputSchema = uuidV7Schema;

/** `published: false` when the document and pinned steps matched the latest version. */
export const publishPipelineVersionResultSchema = z.object({
  published: z.boolean(),
  version: pipelineVersionSchema,
  pipelineDefinition: pipelineDefinitionSchema,
});

export type PinnedStepContract = z.infer<typeof pinnedStepSchema>;
export type PipelineVersionContract = z.infer<typeof pipelineVersionSchema>;
export type PipelineVersionSummaryContract = z.infer<
  typeof pipelineVersionSummarySchema
>;
export type PipelineDefinitionContract = z.infer<
  typeof pipelineDefinitionSchema
>;
export type CreatePipelineDefinitionInput = z.input<
  typeof createPipelineDefinitionInputSchema
>;
export type PublishPipelineVersionInput = z.input<
  typeof publishPipelineVersionInputSchema
>;
export type PipelineVersionRefInput = z.input<
  typeof pipelineVersionRefInputSchema
>;
export type GetPipelineDefinitionInput = z.input<
  typeof getPipelineDefinitionInputSchema
>;
export type ListPipelineDefinitionsByProjectIdInput = z.input<
  typeof listPipelineDefinitionsByProjectIdInputSchema
>;
export type PublishPipelineVersionResult = z.infer<
  typeof publishPipelineVersionResultSchema
>;

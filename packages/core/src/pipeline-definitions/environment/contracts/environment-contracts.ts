import {
  environmentContentSchema,
  environmentNameSchema,
  storedEnvironmentContentSchema,
} from "@scarn/core/common/contracts/environment";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { z } from "zod";

export const publishEnvironmentVersionInputSchema = z.object({
  projectId: uuidV7Schema,
  name: environmentNameSchema,
  content: environmentContentSchema,
});

export type PublishEnvironmentVersionInput = z.input<
  typeof publishEnvironmentVersionInputSchema
>;

export const listEnvironmentsInputSchema = z.object({
  projectId: uuidV7Schema,
});

export type ListEnvironmentsInput = z.input<typeof listEnvironmentsInputSchema>;

export const getEnvironmentInputSchema = z.object({
  projectId: uuidV7Schema,
  name: environmentNameSchema,
  version: z.number().int().positive().optional(),
});

export type GetEnvironmentInput = z.input<typeof getEnvironmentInputSchema>;

export const deleteEnvironmentInputSchema = z.object({
  projectId: uuidV7Schema,
  name: environmentNameSchema,
});

export type DeleteEnvironmentInput = z.input<
  typeof deleteEnvironmentInputSchema
>;

const userRefSchema = z.object({
  userId: uuidV7Schema,
  /** `null` when unresolved. */
  username: z.string().nullable(),
});

/** A named environment as listed: its latest version's description and author. */
export const environmentSchema = z.object({
  id: uuidV7Schema,
  projectId: uuidV7Schema,
  name: z.string(),
  description: z.string().nullable(),
  latestVersion: z.number().int(),
  /** Who published the latest version. */
  updatedBy: userRefSchema,
  /** When the latest version was published. */
  updatedAt: z.iso.datetime(),
});

export type EnvironmentContract = z.output<typeof environmentSchema>;

export const environmentVersionSchema = z.object({
  id: uuidV7Schema,
  environmentId: uuidV7Schema,
  version: z.number().int(),
  content: storedEnvironmentContentSchema,
  contentHash: z.string(),
  createdBy: userRefSchema,
  createdAt: z.iso.datetime(),
});

export type EnvironmentVersionContract = z.output<
  typeof environmentVersionSchema
>;

export const environmentWithVersionSchema = z.object({
  environment: environmentSchema,
  version: environmentVersionSchema,
});

export type EnvironmentWithVersionContract = z.output<
  typeof environmentWithVersionSchema
>;

/** `published` is false when the content matched the latest version and nothing was written. */
export const publishEnvironmentVersionResultSchema =
  environmentWithVersionSchema.extend({ published: z.boolean() });

export type PublishEnvironmentVersionResult = z.output<
  typeof publishEnvironmentVersionResultSchema
>;

export const deleteEnvironmentResultSchema = z.object({
  deleted: z.literal(true),
});

export type DeleteEnvironmentResult = z.output<
  typeof deleteEnvironmentResultSchema
>;

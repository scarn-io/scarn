import { z } from "zod";
import {
  ENV_VAR_NAME_PATTERN,
  isReservedEnvVarName,
} from "@scarn/sdk/env-vars";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { SECRET_NAME_MAX_LENGTH } from "../domain/secret-entity";
import { SECRET_VALUE_MAX_LENGTH } from "./secret-contracts";

/**
 * Project secrets: named values saved on a project and referenced by name
 * from its environments. No contract ever carries a value; only `lastFour`.
 */
const projectSecretNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(SECRET_NAME_MAX_LENGTH);

/**
 * An exact project secret name as a worker asks for it: the env-var rule
 * `normalizeProjectSecretName` enforces, without trimming.
 */
export const projectSecretEnvVarNameSchema = z
  .string()
  .min(1)
  .max(SECRET_NAME_MAX_LENGTH)
  .refine((name) => ENV_VAR_NAME_PATTERN.test(name), {
    message:
      "Project secret name must be uppercase letters, digits and underscores, not starting with a digit",
  })
  .refine((name) => !isReservedEnvVarName(name), {
    message: "Project secret name is reserved",
  });

const projectSecretValueSchema = z
  .string()
  .trim()
  .min(1)
  .max(SECRET_VALUE_MAX_LENGTH);

export const createProjectSecretSchema = z
  .object({
    name: projectSecretNameSchema,
    value: projectSecretValueSchema,
  })
  .strict();

/** Rename, replace the value, or both. At least one field is required. */
export const updateProjectSecretSchema = z
  .object({
    name: projectSecretNameSchema.optional(),
    value: projectSecretValueSchema.optional(),
  })
  .strict()
  .refine((body) => body.name !== undefined || body.value !== undefined, {
    message: "Provide a name, a value, or both",
  });

export const projectSecretSchema = z.object({
  id: uuidV7Schema,
  projectId: uuidV7Schema,
  name: z.string(),
  lastFour: z.string(),
  /** Who last created, renamed or replaced it; `null` when unrecorded. */
  updatedBy: z
    .object({
      userId: uuidV7Schema,
      /** `null` when unresolved. */
      username: z.string().nullable(),
    })
    .nullable(),
  lastUsedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const deleteProjectSecretResponseSchema = z.object({
  deleted: z.literal(true),
});

export type CreateProjectSecretInput = z.infer<
  typeof createProjectSecretSchema
>;
export type UpdateProjectSecretInput = z.infer<
  typeof updateProjectSecretSchema
>;
export type ProjectSecretContract = z.infer<typeof projectSecretSchema>;
export type DeleteProjectSecretResponse = z.infer<
  typeof deleteProjectSecretResponseSchema
>;

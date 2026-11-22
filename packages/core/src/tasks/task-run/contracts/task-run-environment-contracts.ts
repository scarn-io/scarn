import { z } from "zod";
import { projectSecretEnvVarNameSchema } from "@scarn/core/secrets/secret/contracts/project-secret-contracts";

export const TASK_RUN_ENVIRONMENT_MAX_SECRET_NAMES = 100;

/**
 * A worker's one request per run for the project secrets its environment
 * names but its own `.scarn/.env` doesn't set.
 */
export const resolveTaskRunEnvironmentInputSchema = z.object({
  claimToken: z.string().trim().min(1),
  secretNames: z
    .array(projectSecretEnvVarNameSchema)
    .min(1)
    .max(TASK_RUN_ENVIRONMENT_MAX_SECRET_NAMES)
    .refine((names) => new Set(names).size === names.length, {
      message: "secretNames must be unique",
    }),
});

export const taskRunEnvironmentSecretSchema = z.object({
  value: z.string(),
  /** Always `null` for now: project secrets are static API keys. */
  expiresAt: z.iso.datetime().nullable(),
});

export const taskRunEnvironmentSchema = z.object({
  secrets: z.record(z.string(), taskRunEnvironmentSecretSchema),
  /** Requested names the project has no secret for, in request order. */
  missing: z.array(z.string()),
});

export type ResolveTaskRunEnvironmentInput = z.input<
  typeof resolveTaskRunEnvironmentInputSchema
>;
export type TaskRunEnvironmentContract = z.infer<
  typeof taskRunEnvironmentSchema
>;

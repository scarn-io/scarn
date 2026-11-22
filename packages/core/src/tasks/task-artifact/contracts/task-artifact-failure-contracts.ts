import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { artifactKindSchema } from "@scarn/sdk/contracts/artifacts";
import { z } from "zod";

const nonEmptyStringSchema = z.string().trim().min(1);

/**
 * Request to persist metadata for an artifact upload the worker attempted but
 * failed to complete (storage quota, network error, etc.). Purely
 * informational — recorded so the failure is visible to callers, never
 * consulted by policy evaluation. Mirrors `recordArtifactInputSchema`
 * (`task-artifact-contracts.ts`) but has no `objectKey`: a failed
 * upload never produced a server-derived key to anti-spoof against.
 */
export const recordArtifactFailureInputSchema = z.object({
  claimToken: nonEmptyStringSchema,
  relativeStorePath: nonEmptyStringSchema,
  attemptedSizeBytes: z.number().int().nonnegative(),
  kind: artifactKindSchema.optional(),
  errorCode: nonEmptyStringSchema,
  errorMessage: nonEmptyStringSchema,
  httpStatus: z.number().int().positive().optional(),
});

/** A persisted task artifact-failure row. */
export const artifactFailureSchema = z.object({
  id: uuidV7Schema,
  taskRunId: uuidV7Schema,
  relativeStorePath: nonEmptyStringSchema,
  attemptedSizeBytes: z.number().int().nonnegative(),
  kind: artifactKindSchema,
  errorCode: nonEmptyStringSchema,
  errorMessage: nonEmptyStringSchema,
  httpStatus: z.number().int().positive().nullable(),
  createdAt: z.iso.datetime(),
});

export type RecordArtifactFailureInput = z.input<
  typeof recordArtifactFailureInputSchema
>;
export type ArtifactFailureContract = z.infer<typeof artifactFailureSchema>;

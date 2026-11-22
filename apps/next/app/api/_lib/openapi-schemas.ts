import { z } from "zod";

export const apiErrorResponseSchema = z.object({
  error: z.string(),
  details: z.unknown().optional(),
});

export const environmentUpsertResponseSchema = z.object({
  success: z.literal(true),
  environmentId: z.string(),
});

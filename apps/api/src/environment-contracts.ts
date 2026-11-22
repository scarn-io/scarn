import { z } from "zod";

export const environmentUpsertResponseSchema = z.object({
  success: z.literal(true),
  environmentId: z.string(),
});

import { z } from "zod";

export const problemDetailsErrorItemSchema = z.object({
  path: z.string(),
  message: z.string(),
  summary: z.string().optional(),
});

export const apiErrorResponseSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: z.string().optional(),
  errors: z.array(problemDetailsErrorItemSchema).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

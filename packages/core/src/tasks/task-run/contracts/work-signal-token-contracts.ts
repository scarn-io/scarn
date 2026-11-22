import { z } from "zod";

export const issueWorkSignalTokenInputSchema = z.object({
  /** Becomes the token's `sub`; defaults to the caller's user id. */
  workerId: z.string().trim().min(1).max(200).optional(),
});

export type IssueWorkSignalTokenInput = z.infer<
  typeof issueWorkSignalTokenInputSchema
>;

export const workSignalTokenSchema = z.object({
  /** Base URL of the work-signal service; connect at `${url}/projects/:projectId/connect?token=…`. */
  url: z.string(),
  token: z.string(),
  expiresAt: z.string(),
});

export type WorkSignalTokenContract = z.infer<typeof workSignalTokenSchema>;

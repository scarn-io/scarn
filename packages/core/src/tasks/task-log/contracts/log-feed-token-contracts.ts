import { z } from "zod";

export const issueLogFeedWriteTokenInputSchema = z.object({
  claimToken: z.string().trim().min(1),
});

export type IssueLogFeedWriteTokenInput = z.infer<
  typeof issueLogFeedWriteTokenInputSchema
>;

export const logFeedTokenSchema = z.object({
  /**
   * WebSocket URL of this task run's live log feed
   * (`wss://…/task-runs/:taskRunId/ws`); connect with `?token=…&from=N`.
   */
  url: z.string(),
  token: z.string(),
  expiresAt: z.string(),
});

export type LogFeedTokenContract = z.infer<typeof logFeedTokenSchema>;

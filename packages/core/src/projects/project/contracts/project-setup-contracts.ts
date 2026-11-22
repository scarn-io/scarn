import { z } from "zod";
import { integrationCredentialChoiceSchema } from "@scarn/core/secrets/secret/contracts/secret-contracts";
import { projectGitUrlSchema } from "../domain/project-git-url";
import { createProjectInputSchema, projectSchema } from "./project-contracts";

const firstSyncHorizonDaysSchema = z.number().int().nonnegative().optional();

/**
 * Lends the saved credential to the new integration so Scarn syncs it every
 * 5 minutes. Only a saved key can be lent; a pasted one is rejected.
 */
const autoSyncSchema = z.boolean().optional();

const githubAppIssueTrackerSchema = z
  .object({
    type: z.literal("github_app"),
    installationId: z.string().min(1),
    firstSyncHorizonDays: firstSyncHorizonDaysSchema,
  })
  .strict();

const githubTokenIssueTrackerSchema = z
  .object({
    type: z.literal("github_token"),
    credential: integrationCredentialChoiceSchema,
    firstSyncHorizonDays: firstSyncHorizonDaysSchema,
    autoSync: autoSyncSchema,
  })
  .strict();

const bitbucketIssueTrackerSchema = z
  .object({
    type: z.literal("bitbucket"),
    credential: integrationCredentialChoiceSchema,
    firstSyncHorizonDays: firstSyncHorizonDaysSchema,
  })
  .strict();

const jiraIssueTrackerSchema = z
  .object({
    type: z.literal("jira"),
    baseUrl: z.url(),
    projectKeys: z.array(z.string().trim().min(1)).min(1),
    credential: integrationCredentialChoiceSchema,
    firstSyncHorizonDays: firstSyncHorizonDaysSchema,
    autoSync: autoSyncSchema,
  })
  .strict();

/**
 * Where a new project's issues come from. Left out entirely when the user
 * skips issue tracking. A credential is used for this request only and never
 * saved.
 */
export const issueTrackerSchema = z.discriminatedUnion("type", [
  githubAppIssueTrackerSchema,
  githubTokenIssueTrackerSchema,
  bitbucketIssueTrackerSchema,
  jiraIssueTrackerSchema,
]);

/**
 * The trackers `POST /projects/issue-tracker-check` verifies. A GitHub App
 * installation's coverage of the repo is answered by `/projects/repo-check`.
 */
export const issueTrackerCheckSchema = z.discriminatedUnion("type", [
  githubTokenIssueTrackerSchema.omit({ autoSync: true }),
  bitbucketIssueTrackerSchema,
  jiraIssueTrackerSchema.omit({ autoSync: true }),
]);

export const setUpProjectInputSchema = createProjectInputSchema.extend({
  issueTracker: issueTrackerSchema.optional(),
});

export const setUpProjectResponseSchema = projectSchema.extend({
  /**
   * `true` when the first sync threw. The project and integration are kept
   * either way, and the integration's `lastError` records the failure.
   */
  initialSyncFailed: z.boolean(),
});

export const repoCheckInputSchema = z.object({
  gitUrl: projectGitUrlSchema,
});

export const repoCheckResponseSchema = z.object({
  host: z.enum(["github", "bitbucket", "other"]),
  webUrl: z.string().nullable(),
  defaultName: z.string().min(1),
  alreadyExists: z.boolean(),
  /**
   * One of the caller's projects that already uses this repo, for linking to
   * it. Null when `alreadyExists` is false.
   */
  existingProject: z
    .object({
      name: z.string(),
      slug: z.string(),
      ownerUsername: z.string().nullable(),
    })
    .nullable(),
  /**
   * Only present for a GitHub repo when the GitHub App is configured: the
   * caller's installation that covers the repo, or null when none does.
   */
  githubApp: z
    .object({
      installationId: z.string(),
      accountLogin: z.string().nullable(),
    })
    .nullable()
    .optional(),
});

export const issueTrackerCheckInputSchema = z.object({
  gitUrl: projectGitUrlSchema,
  issueTracker: issueTrackerCheckSchema,
});

export const issueTrackerCheckResponseSchema = z.object({
  ok: z.literal(true),
  /** The account the credential belongs to, for display. */
  account: z.string(),
  issuesEnabled: z.boolean(),
  /** The GitHub repo the credential can read; null for Bitbucket and Jira. */
  repo: z.object({ id: z.number().int(), fullName: z.string() }).nullable(),
});

export type IssueTrackerInput = z.infer<typeof issueTrackerSchema>;
export type IssueTrackerCheckInput = z.infer<typeof issueTrackerCheckSchema>;
export type SetUpProjectInput = z.input<typeof setUpProjectInputSchema>;
export type SetUpProjectResponse = z.infer<typeof setUpProjectResponseSchema>;
export type RepoCheckInput = z.input<typeof repoCheckInputSchema>;
export type RepoCheckResponse = z.infer<typeof repoCheckResponseSchema>;
export type IssueTrackerCheckRequest = z.input<
  typeof issueTrackerCheckInputSchema
>;
export type IssueTrackerCheckResponse = z.infer<
  typeof issueTrackerCheckResponseSchema
>;

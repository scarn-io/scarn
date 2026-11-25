import { z } from "zod";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";

export const projectIntegrationStatusValues = [
  "active",
  "paused",
  "error",
] as const;

export const projectIntegrationKindValues = [
  "github_app",
  "github_token",
  "bitbucket",
  "jira",
] as const;

export const projectIntegrationAuthModeValues = [
  "github_app",
  "user_credential",
] as const;

export const projectIntegrationRepoSchema = z.object({
  id: z.number().int(),
  fullName: z.string().trim().min(1),
});

export const githubIntegrationScopeSchema = z
  .object({
    repos: z.array(projectIntegrationRepoSchema).min(1),
  })
  .strict();

export const bitbucketIntegrationRepoSchema = z
  .object({
    workspace: z.string().trim().min(1),
    slug: z.string().trim().min(1),
    fullName: z.string().trim().min(1),
  })
  .strict();

export const bitbucketIntegrationScopeSchema = z
  .object({
    repos: z.array(bitbucketIntegrationRepoSchema).min(1),
  })
  .strict();

export const jiraIntegrationScopeSchema = z
  .object({
    baseUrl: z.url(),
    projectKeys: z.array(z.string().min(1)).min(1),
  })
  .strict();

const projectIntegrationBaseSchema = z.object({
  id: uuidV7Schema,
  projectId: uuidV7Schema,
  status: z.enum(projectIntegrationStatusValues),
  lastSyncedAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
  firstSyncHorizonDays: z.number().int().nonnegative().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const githubAppProjectIntegrationSchema =
  projectIntegrationBaseSchema.extend({
    kind: z.literal("github_app"),
    platform: z.literal("github"),
    authMode: z.literal("github_app"),
    installationId: z.string().min(1),
    externalScope: githubIntegrationScopeSchema,
  });

export const githubTokenProjectIntegrationSchema =
  projectIntegrationBaseSchema.extend({
    kind: z.literal("github_token"),
    platform: z.literal("github"),
    authMode: z.literal("user_credential"),
    externalScope: githubIntegrationScopeSchema,
  });

export const bitbucketProjectIntegrationSchema =
  projectIntegrationBaseSchema.extend({
    kind: z.literal("bitbucket"),
    platform: z.literal("bitbucket"),
    authMode: z.literal("user_credential"),
    externalScope: bitbucketIntegrationScopeSchema,
  });

export const jiraProjectIntegrationSchema = projectIntegrationBaseSchema.extend(
  {
    kind: z.literal("jira"),
    platform: z.literal("jira"),
    authMode: z.literal("user_credential"),
    externalScope: jiraIntegrationScopeSchema,
  },
);

export const projectIntegrationSchema = z.discriminatedUnion("kind", [
  githubAppProjectIntegrationSchema,
  githubTokenProjectIntegrationSchema,
  bitbucketProjectIntegrationSchema,
  jiraProjectIntegrationSchema,
]);

const firstSyncHorizonDaysInputSchema = z
  .number()
  .int()
  .nonnegative()
  .optional();

export const createProjectIntegrationInputSchema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("github_app"),
        installationId: z.string().min(1),
        externalScope: githubIntegrationScopeSchema,
        firstSyncHorizonDays: firstSyncHorizonDaysInputSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("github_token"),
        externalScope: githubIntegrationScopeSchema,
        firstSyncHorizonDays: firstSyncHorizonDaysInputSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("bitbucket"),
        externalScope: bitbucketIntegrationScopeSchema,
        firstSyncHorizonDays: firstSyncHorizonDaysInputSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("jira"),
        externalScope: jiraIntegrationScopeSchema,
        firstSyncHorizonDays: firstSyncHorizonDaysInputSchema,
      })
      .strict(),
  ],
);

export type ProjectIntegrationContract = z.infer<
  typeof projectIntegrationSchema
>;
export type GitHubAppProjectIntegrationContract = z.infer<
  typeof githubAppProjectIntegrationSchema
>;
export type GitHubTokenProjectIntegrationContract = z.infer<
  typeof githubTokenProjectIntegrationSchema
>;
export type BitbucketProjectIntegrationContract = z.infer<
  typeof bitbucketProjectIntegrationSchema
>;
export type BitbucketIntegrationScopeContract = z.infer<
  typeof bitbucketIntegrationScopeSchema
>;
export type JiraProjectIntegrationContract = z.infer<
  typeof jiraProjectIntegrationSchema
>;
export type GitHubIntegrationScopeContract = z.infer<
  typeof githubIntegrationScopeSchema
>;
export type JiraIntegrationScopeContract = z.infer<
  typeof jiraIntegrationScopeSchema
>;
export type CreateProjectIntegrationRouteInput = z.input<
  typeof createProjectIntegrationInputSchema
>;

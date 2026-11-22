import { z } from "zod";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";

export const githubInstallationRepositorySchema = z.object({
  id: z.number().int(),
  fullName: z.string().trim().min(1),
});

export const githubInstallationSchema = z.object({
  id: uuidV7Schema,
  installationId: z.string().min(1),
  accountLogin: z.string().nullable(),
  accountType: z.enum(["User", "Organization"]).nullable(),
  targetType: z.enum(["all", "selected"]).nullable(),
  selectedRepositories: z.array(githubInstallationRepositorySchema),
  installedByUserId: uuidV7Schema.nullable(),
  createdAt: z.iso.datetime(),
});

export type GitHubInstallationContract = z.infer<
  typeof githubInstallationSchema
>;

/**
 * One installation's cached repo list, as returned by `GET
 * /integrations/github/repos` (one entry per installation the caller owns)
 * and by `POST /integrations/github/installations/:installationId/refresh`
 * (a single entry for the refreshed installation).
 */
export const myGitHubInstallationReposSchema = z.object({
  installationId: z.string().min(1),
  accountLogin: z.string().nullable(),
  repos: z.array(githubInstallationRepositorySchema),
});

export type MyGitHubInstallationReposContract = z.infer<
  typeof myGitHubInstallationReposSchema
>;

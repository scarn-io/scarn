import { z } from "zod";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { WORK_ITEM_PLATFORMS } from "@scarn/core/work-items/work-item/domain/work-item-platform";
import {
  SECRET_NAME_MAX_LENGTH,
  secretStatusValues,
} from "../domain/secret-entity";

export const SECRET_VALUE_MAX_LENGTH = 4096;

const GITHUB_LOGIN_MAX_LENGTH = 39;

const emailSchema = z.string().trim().toLowerCase().check(z.email());

const secretNameSchema = z.string().trim().min(1).max(SECRET_NAME_MAX_LENGTH);

const secretValueSchema = z.string().trim().min(1).max(SECRET_VALUE_MAX_LENGTH);

/** The kinds a user saves for themselves; project secrets have their own contracts. */
export const secretKindSchema = z.enum([
  "jira_api_key",
  "github_token",
  "bitbucket_api_token",
]);

export const secretStatusSchema = z.enum(secretStatusValues);

export const createJiraApiKeySecretSchema = z
  .object({
    kind: z.literal("jira_api_key"),
    name: secretNameSchema,
    email: emailSchema,
    value: secretValueSchema,
    expiresAt: z.iso.datetime(),
  })
  .strict();

export const createGitHubTokenSecretSchema = z
  .object({
    kind: z.literal("github_token"),
    name: secretNameSchema,
    value: secretValueSchema,
    login: z.string().trim().min(1).max(GITHUB_LOGIN_MAX_LENGTH).optional(),
    expiresAt: z.iso.datetime().nullable().optional(),
  })
  .strict();

export const createBitbucketApiTokenSecretSchema = z
  .object({
    kind: z.literal("bitbucket_api_token"),
    name: secretNameSchema,
    email: emailSchema,
    value: secretValueSchema,
    expiresAt: z.iso.datetime(),
  })
  .strict();

export const createSecretSchema = z.discriminatedUnion("kind", [
  createJiraApiKeySecretSchema,
  createGitHubTokenSecretSchema,
  createBitbucketApiTokenSecretSchema,
]);

export const renameSecretSchema = z
  .object({
    name: secretNameSchema,
  })
  .strict();

export const listSecretsQuerySchema = z.object({
  kind: secretKindSchema.optional(),
});

/** A project integration the key is lent to for auto-sync. */
export const secretUseSchema = z.object({
  projectId: uuidV7Schema,
  projectName: z.string(),
  integrationId: uuidV7Schema,
  platform: z.enum(WORK_ITEM_PLATFORMS),
});

export const jiraApiKeySecretSchema = z.object({
  id: uuidV7Schema,
  kind: z.literal("jira_api_key"),
  name: z.string(),
  metadata: z.object({ email: z.string() }),
  lastFour: z.string(),
  expiresAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  status: secretStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  usedBy: z.array(secretUseSchema),
});

export const githubTokenSecretSchema = z.object({
  id: uuidV7Schema,
  kind: z.literal("github_token"),
  name: z.string(),
  metadata: z.object({ login: z.string().nullable() }),
  lastFour: z.string(),
  expiresAt: z.iso.datetime().nullable(),
  lastUsedAt: z.iso.datetime().nullable(),
  status: secretStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  usedBy: z.array(secretUseSchema),
});

export const bitbucketApiTokenSecretSchema = z.object({
  id: uuidV7Schema,
  kind: z.literal("bitbucket_api_token"),
  name: z.string(),
  metadata: z.object({ email: z.string() }),
  lastFour: z.string(),
  expiresAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  status: secretStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  usedBy: z.array(secretUseSchema),
});

export const secretSchema = z.discriminatedUnion("kind", [
  jiraApiKeySecretSchema,
  githubTokenSecretSchema,
  bitbucketApiTokenSecretSchema,
]);

export const deleteSecretResponseSchema = z.object({
  deleted: z.literal(true),
});

const savedCredentialChoiceSchema = z
  .object({ secretId: uuidV7Schema })
  .strict();

const pastedJiraCredentialSchema = z
  .object({
    email: emailSchema,
    apiKey: secretValueSchema,
  })
  .strict();

const pastedGitHubCredentialSchema = z
  .object({ token: secretValueSchema })
  .strict();

const pastedBitbucketCredentialSchema = z
  .object({
    email: emailSchema,
    apiToken: secretValueSchema,
  })
  .strict();

/**
 * How a caller supplies a Jira credential on a request: a saved secret it
 * owns, or a pasted email + API token pair. Never both.
 */
export const jiraCredentialChoiceSchema = z.union([
  savedCredentialChoiceSchema,
  pastedJiraCredentialSchema,
]);

/**
 * How a caller supplies a GitHub personal access token on a request: a saved
 * secret it owns, or a pasted token. Never both.
 */
export const githubCredentialChoiceSchema = z.union([
  savedCredentialChoiceSchema,
  pastedGitHubCredentialSchema,
]);

/**
 * How a caller supplies a Bitbucket credential on a request: a saved secret
 * it owns, or a pasted Atlassian email + API token pair. Never both.
 */
export const bitbucketCredentialChoiceSchema = z.union([
  savedCredentialChoiceSchema,
  pastedBitbucketCredentialSchema,
]);

/**
 * Any platform's credential choice. The resolver for the platform a request
 * targets rejects a pasted credential shaped for another platform with
 * `CREDENTIAL_PLATFORM_MISMATCH`.
 */
export const integrationCredentialChoiceSchema = z.union([
  savedCredentialChoiceSchema,
  pastedJiraCredentialSchema,
  pastedGitHubCredentialSchema,
  pastedBitbucketCredentialSchema,
]);

export type SecretKindContract = z.infer<typeof secretKindSchema>;
export type SecretStatusContract = z.infer<typeof secretStatusSchema>;
export type CreateSecretInput = z.infer<typeof createSecretSchema>;
export type RenameSecretInput = z.infer<typeof renameSecretSchema>;
export type ListSecretsQuery = z.infer<typeof listSecretsQuerySchema>;
export type SecretContract = z.infer<typeof secretSchema>;
export type SecretUseContract = z.infer<typeof secretUseSchema>;
export type JiraApiKeySecretContract = z.infer<typeof jiraApiKeySecretSchema>;
export type GitHubTokenSecretContract = z.infer<typeof githubTokenSecretSchema>;
export type BitbucketApiTokenSecretContract = z.infer<
  typeof bitbucketApiTokenSecretSchema
>;
export type DeleteSecretResponse = z.infer<typeof deleteSecretResponseSchema>;
export type JiraCredentialChoice = z.infer<typeof jiraCredentialChoiceSchema>;
export type GitHubCredentialChoice = z.infer<
  typeof githubCredentialChoiceSchema
>;
export type BitbucketCredentialChoice = z.infer<
  typeof bitbucketCredentialChoiceSchema
>;
export type IntegrationCredentialChoice = z.infer<
  typeof integrationCredentialChoiceSchema
>;

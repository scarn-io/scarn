import { createApp } from "@scarn/api/app";
import { createAppContext } from "@/lib/di";
import type { TimeProvider } from "@/lib/time-provider";
import type { CreateSecretInput } from "@/secrets/secret/contracts/secret-contracts";
import { createScarnTreaty } from "tests/treaty";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { fixedTimeProvider } from "tests/utils";

export const SECRETS_TEST_NOW = new Date("2026-10-20T12:00:00.000Z");

const DAY_MS = 24 * 60 * 60 * 1000;

export const daysFromNow = (days: number): string =>
  new Date(SECRETS_TEST_NOW.getTime() + days * DAY_MS).toISOString();

export const createSecretsTestClient = (
  timeProvider: TimeProvider = fixedTimeProvider(SECRETS_TEST_NOW),
) => createScarnTreaty(createApp(createAppContext({ timeProvider })));

export const createSecretsTestUser = async () =>
  await createTestUserAndSession({
    email: `secrets-${crypto.randomUUID()}@example.com`,
  });

export const jiraApiKeyInput = (
  overrides: Partial<Extract<CreateSecretInput, { kind: "jira_api_key" }>> = {},
): CreateSecretInput => ({
  kind: "jira_api_key",
  name: `Jira ${crypto.randomUUID()}`,
  email: "me@example.com",
  value: `jira-token-${crypto.randomUUID()}`,
  expiresAt: daysFromNow(90),
  ...overrides,
});

export const githubTokenInput = (
  overrides: Partial<Extract<CreateSecretInput, { kind: "github_token" }>> = {},
): CreateSecretInput => ({
  kind: "github_token",
  name: `GitHub ${crypto.randomUUID()}`,
  value: `ghp_${crypto.randomUUID()}`,
  ...overrides,
});

export const bitbucketApiTokenInput = (
  overrides: Partial<
    Extract<CreateSecretInput, { kind: "bitbucket_api_token" }>
  > = {},
): CreateSecretInput => ({
  kind: "bitbucket_api_token",
  name: `Bitbucket ${crypto.randomUUID()}`,
  email: "me@example.com",
  value: `bitbucket-token-${crypto.randomUUID()}`,
  expiresAt: daysFromNow(90),
  ...overrides,
});

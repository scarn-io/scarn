import type {
  CreateSecretInput,
  IntegrationCredentialChoice,
  SecretContract,
} from "@scarn/core/secrets/secret/contracts/secret-contracts";

export const ACCOUNT_SETTINGS_HREF = "/account/settings";

/**
 * The platforms a user's own token can connect. Each one maps to a saved
 * secret kind and to the shape of a pasted credential.
 */
export type CredentialPlatform = "github" | "bitbucket" | "jira";

export type SavedCredentialKind = SecretContract["kind"];

type CredentialPlatformConfig = {
  secretKind: SavedCredentialKind;
  label: string;
  defaultSecretName: string;
  tokenLabel: string;
  needsEmail: boolean;
  expiryRequired: boolean;
};

export const CREDENTIAL_PLATFORMS: Record<
  CredentialPlatform,
  CredentialPlatformConfig
> = {
  github: {
    secretKind: "github_token",
    label: "GitHub",
    defaultSecretName: "GitHub token",
    tokenLabel: "GitHub token",
    needsEmail: false,
    expiryRequired: false,
  },
  bitbucket: {
    secretKind: "bitbucket_api_token",
    label: "Bitbucket",
    defaultSecretName: "Bitbucket token",
    tokenLabel: "API token",
    needsEmail: true,
    expiryRequired: true,
  },
  jira: {
    secretKind: "jira_api_key",
    label: "Jira",
    defaultSecretName: "Jira token",
    tokenLabel: "API token",
    needsEmail: true,
    expiryRequired: true,
  },
};

/** What the user typed for a new token. `email` is ignored where unused. */
export type PastedCredentialInput = { email: string; token: string };

export const isPastedCredentialComplete = (
  platform: CredentialPlatform,
  input: PastedCredentialInput,
): boolean =>
  input.token.trim().length > 0 &&
  (!CREDENTIAL_PLATFORMS[platform].needsEmail || input.email.trim().length > 0);

export const pastedCredential = (
  platform: CredentialPlatform,
  input: PastedCredentialInput,
): IntegrationCredentialChoice => {
  switch (platform) {
    case "github":
      return { token: input.token.trim() };
    case "bitbucket":
      return { email: input.email.trim(), apiToken: input.token.trim() };
    case "jira":
      return { email: input.email.trim(), apiKey: input.token.trim() };
  }
};

export type SaveSecretInput = {
  name: string;
  /** ISO date-time, or null for a GitHub token that never expires. */
  expiresAt: string | null;
  /** The account the check found; stored as the GitHub token's login. */
  account: string | null;
};

/** The `POST /me/secrets` body that saves a pasted credential. */
export const saveSecretBody = (
  platform: CredentialPlatform,
  input: PastedCredentialInput,
  save: SaveSecretInput,
): CreateSecretInput => {
  switch (platform) {
    case "github":
      return {
        kind: "github_token",
        name: save.name.trim(),
        value: input.token.trim(),
        expiresAt: save.expiresAt,
        ...(save.account ? { login: save.account } : {}),
      };
    case "bitbucket":
      return {
        kind: "bitbucket_api_token",
        name: save.name.trim(),
        email: input.email.trim(),
        value: input.token.trim(),
        expiresAt: save.expiresAt ?? "",
      };
    case "jira":
      return {
        kind: "jira_api_key",
        name: save.name.trim(),
        email: input.email.trim(),
        value: input.token.trim(),
        expiresAt: save.expiresAt ?? "",
      };
  }
};

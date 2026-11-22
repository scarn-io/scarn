import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { CoreError } from "@scarn/core/lib/errors";
import type { IntegrationCredentialChoice } from "../contracts/secret-contracts";
import {
  credentialPlatformMismatchError,
  decryptSavedCredential,
  pastedCredentialPlatform,
  type ResolveCredentialDeps,
} from "./decrypt-saved-credential";

export type ResolveJiraCredentialDeps = ResolveCredentialDeps;

export type ResolvedJiraCredential = {
  email: string;
  apiToken: string;
  /** The saved secret the pair came from, or null for a pasted pair. */
  secretId: UuidV7 | null;
  /** The saved secret's name, or null for a pasted pair. */
  secretName: string | null;
};

/**
 * Turns the caller's credential choice into the email + API token pair to
 * send to Jira. A saved secret must belong to the caller, be a Jira API key
 * and not be expired; a pasted credential must be a Jira email + API key
 * pair. The value is never logged or put in an error.
 */
export const resolveJiraCredential = async (
  choice: IntegrationCredentialChoice | undefined,
  deps: ResolveJiraCredentialDeps,
): Promise<ResolvedJiraCredential> => {
  if (!choice) {
    throw new CoreError({
      code: "JIRA_API_KEY_REQUIRED",
      message: "A Jira API key is required for this Jira request",
      status: 400,
    });
  }

  if (!("secretId" in choice)) {
    if (!("apiKey" in choice)) {
      throw credentialPlatformMismatchError(
        "jira",
        pastedCredentialPlatform(choice),
      );
    }
    return {
      email: choice.email,
      apiToken: choice.apiKey,
      secretId: null,
      secretName: null,
    };
  }

  const { secret, value } = await decryptSavedCredential(
    choice.secretId,
    "jira_api_key",
    "Jira API key",
    deps,
  );
  return {
    email: secret.metadata.email,
    apiToken: value,
    secretId: secret.id,
    secretName: secret.name,
  };
};

/**
 * Builds the `JIRA_API_KEY_REJECTED` error for a Jira 401. It names the saved
 * key when there is one and never includes the email, token or Jira's
 * response body.
 */
export const jiraCredentialRejectedError = (
  credential: Pick<ResolvedJiraCredential, "secretName">,
): CoreError =>
  new CoreError({
    code: "JIRA_API_KEY_REJECTED",
    message:
      credential.secretName === null
        ? "Jira rejected that email and API token."
        : `Jira rejected the saved key "${credential.secretName}". Check its email and token, or replace it.`,
    status: 400,
  });

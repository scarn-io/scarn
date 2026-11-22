import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { CoreError } from "@scarn/core/lib/errors";
import type { IntegrationCredentialChoice } from "../contracts/secret-contracts";
import {
  credentialPlatformMismatchError,
  decryptSavedCredential,
  pastedCredentialPlatform,
  type ResolveCredentialDeps,
} from "./decrypt-saved-credential";

export type ResolveGitHubCredentialDeps = ResolveCredentialDeps;

export type ResolvedGitHubCredential = {
  token: string;
  /** The saved secret the token came from, or null for a pasted token. */
  secretId: UuidV7 | null;
  /** The saved secret's name, or null for a pasted token. */
  secretName: string | null;
};

export const githubTokenRequiredError = (): CoreError =>
  new CoreError({
    code: "GITHUB_TOKEN_REQUIRED",
    message: "A GitHub token is required for this GitHub request",
    status: 400,
  });

/**
 * Turns the caller's credential choice into the GitHub personal access token
 * to send to GitHub. A saved secret must belong to the caller, be a GitHub
 * token and not be expired; a pasted credential must be a `{ token }`. The
 * value is never logged or put in an error.
 */
export const resolveGitHubCredential = async (
  choice: IntegrationCredentialChoice | undefined,
  deps: ResolveGitHubCredentialDeps,
): Promise<ResolvedGitHubCredential> => {
  if (!choice) {
    throw githubTokenRequiredError();
  }

  if (!("secretId" in choice)) {
    if (!("token" in choice)) {
      throw credentialPlatformMismatchError(
        "github",
        pastedCredentialPlatform(choice),
      );
    }
    return { token: choice.token, secretId: null, secretName: null };
  }

  const { secret, value } = await decryptSavedCredential(
    choice.secretId,
    "github_token",
    "GitHub token",
    deps,
  );
  return { token: value, secretId: secret.id, secretName: secret.name };
};

/**
 * Builds the `GITHUB_TOKEN_REJECTED` error for a GitHub 401. It names the
 * saved key when there is one and never includes the token or GitHub's
 * response body.
 */
export const githubCredentialRejectedError = (
  credential: Pick<ResolvedGitHubCredential, "secretName">,
): CoreError =>
  new CoreError({
    code: "GITHUB_TOKEN_REJECTED",
    message:
      credential.secretName === null
        ? "GitHub rejected that token."
        : `GitHub rejected the saved key "${credential.secretName}". Check the token, or replace it.`,
    status: 400,
  });

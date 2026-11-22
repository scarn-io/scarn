import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { CoreError } from "@scarn/core/lib/errors";
import type { IntegrationCredentialChoice } from "../contracts/secret-contracts";
import {
  credentialPlatformMismatchError,
  decryptSavedCredential,
  pastedCredentialPlatform,
  type ResolveCredentialDeps,
} from "./decrypt-saved-credential";

export type ResolveBitbucketCredentialDeps = ResolveCredentialDeps;

export type ResolvedBitbucketCredential = {
  email: string;
  apiToken: string;
  /** The saved secret the pair came from, or null for a pasted pair. */
  secretId: UuidV7 | null;
  /** The saved secret's name, or null for a pasted pair. */
  secretName: string | null;
};

/**
 * Turns the caller's credential choice into the Atlassian email + API token
 * pair to send to Bitbucket as basic auth. A saved secret must belong to the
 * caller, be a Bitbucket API token and not be expired; a pasted credential
 * must be an `{ email, apiToken }` pair. The value is never logged or put in
 * an error.
 */
export const resolveBitbucketCredential = async (
  choice: IntegrationCredentialChoice | undefined,
  deps: ResolveBitbucketCredentialDeps,
): Promise<ResolvedBitbucketCredential> => {
  if (!choice) {
    throw new CoreError({
      code: "BITBUCKET_API_TOKEN_REQUIRED",
      message: "A Bitbucket API token is required for this Bitbucket request",
      status: 400,
    });
  }

  if (!("secretId" in choice)) {
    if (!("apiToken" in choice)) {
      throw credentialPlatformMismatchError(
        "bitbucket",
        pastedCredentialPlatform(choice),
      );
    }
    return {
      email: choice.email,
      apiToken: choice.apiToken,
      secretId: null,
      secretName: null,
    };
  }

  const { secret, value } = await decryptSavedCredential(
    choice.secretId,
    "bitbucket_api_token",
    "Bitbucket API token",
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
 * Builds the `BITBUCKET_API_TOKEN_REJECTED` error for a Bitbucket 401. It
 * names the saved key when there is one and never includes the email, token
 * or Bitbucket's response body.
 */
export const bitbucketCredentialRejectedError = (
  credential: Pick<ResolvedBitbucketCredential, "secretName">,
): CoreError =>
  new CoreError({
    code: "BITBUCKET_API_TOKEN_REJECTED",
    message:
      credential.secretName === null
        ? "Bitbucket rejected that email and API token."
        : `Bitbucket rejected the saved key "${credential.secretName}". Check its email and token, or replace it.`,
    status: 400,
  });

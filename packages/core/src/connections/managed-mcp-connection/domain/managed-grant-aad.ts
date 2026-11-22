import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";

export type ManagedGrantCredentialsAadInput = {
  projectId: UuidV7;
  connectionId: UuidV7;
  grantId: UuidV7;
  credentialVersion: number;
};

export type ManagedGrantIdentityAadInput = {
  projectId: UuidV7;
  connectionId: UuidV7;
  grantId: UuidV7;
};

export type ManagedAttemptAadInput = {
  projectId: UuidV7;
  connectionId: UuidV7;
  attemptId: UuidV7;
};

const lengthPrefixed = (tag: string, parts: readonly string[]): string =>
  [tag, ...parts.map((part) => `${String(part.length)}:${part}`)].join("|");

/**
 * The additional authenticated data for a grant's encrypted credentials.
 * Every part is length-prefixed, so no two different inputs build the same
 * string, and the tag keeps a credential ciphertext from decrypting as an
 * identity or a PKCE verifier. Bumping `credentialVersion` invalidates the
 * previous ciphertext.
 */
export const managedGrantCredentialsAad = (
  input: ManagedGrantCredentialsAadInput,
): string =>
  lengthPrefixed("managed-oauth-grant:v1", [
    input.projectId,
    input.connectionId,
    input.grantId,
    String(input.credentialVersion),
  ]);

/** The additional authenticated data for a grant's encrypted provider identity. */
export const managedGrantIdentityAad = (
  input: ManagedGrantIdentityAadInput,
): string =>
  lengthPrefixed("managed-oauth-identity:v1", [
    input.projectId,
    input.connectionId,
    input.grantId,
  ]);

/** The additional authenticated data for an authorization attempt's encrypted PKCE verifier. */
export const managedAttemptAad = (input: ManagedAttemptAadInput): string =>
  lengthPrefixed("managed-oauth-attempt:v1", [
    input.projectId,
    input.connectionId,
    input.attemptId,
  ]);

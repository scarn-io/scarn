import { createHash } from "node:crypto";

export type IdentityFingerprintInput = {
  issuer: string;
  workspaceId: string | null;
  userId: string | null;
  scopes: readonly string[];
};

/**
 * A stable digest of who a grant acts as: the issuer, the provider workspace
 * and user, and the granted scopes (sorted and de-duplicated, so their order
 * doesn't matter). Confirming a candidate grant must present the fingerprint
 * of the candidate the person was shown, so a different candidate can't be
 * confirmed in its place.
 */
export const identityFingerprint = (input: IdentityFingerprintInput): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        input.issuer,
        input.workspaceId,
        input.userId,
        [...new Set(input.scopes)].sort(),
      ]),
    )
    .digest("base64url");

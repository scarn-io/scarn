import { createHmac } from "node:crypto";
import { digestsMatch } from "@scarn/core/connections/managed-mcp-connection/domain/managed-oauth-digests";
import { isUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";

/**
 * Preview tokens (plan Phase 4): let a project member open a bundle on the
 * content origin before (or without) sharing it. A token is
 * `pv1.<claims>.<mac>`, where `claims` is base64url JSON `{b, u, e}` (bundle
 * id, user id, expiry in epoch seconds) and
 * `mac = HMAC-SHA256(ARTIFACT_SHARE_SECRET, "preview:" + claims)`, base64url.
 *
 * The `preview:` prefix separates the two token kinds under one secret: a
 * share token's MAC covers a bare share id, which never starts with
 * `preview:`, so neither kind's MAC verifies as the other. The `pv1.` prefix
 * also gives the two a different shape. Every part is base64url, so the token
 * is safe in a URL path segment.
 */
export type PreviewTokenClaims = {
  bundleId: UuidV7;
  userId: string;
  /** When the token stops working. */
  exp: Date;
};

export const PREVIEW_TOKEN_TTL_MS = 15 * 60 * 1000;

const PREVIEW_TOKEN_PREFIX = "pv1";

const previewTokenMac = (secret: string, encodedClaims: string): string =>
  createHmac("sha256", secret)
    .update(`preview:${encodedClaims}`)
    .digest("base64url");

export const previewTokenExpiry = (now: Date): Date =>
  new Date(now.getTime() + PREVIEW_TOKEN_TTL_MS);

export const buildPreviewToken = (
  secret: string,
  claims: PreviewTokenClaims,
): string => {
  const encodedClaims = Buffer.from(
    JSON.stringify({
      b: claims.bundleId,
      u: claims.userId,
      e: Math.floor(claims.exp.getTime() / 1000),
    }),
  ).toString("base64url");
  return `${PREVIEW_TOKEN_PREFIX}.${encodedClaims}.${previewTokenMac(secret, encodedClaims)}`;
};

const decodeClaims = (encoded: string): PreviewTokenClaims | null => {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const { b, u, e } = parsed as Record<string, unknown>;
    if (
      typeof b !== "string" ||
      !isUuidV7(b) ||
      typeof u !== "string" ||
      u.length === 0 ||
      typeof e !== "number" ||
      !Number.isSafeInteger(e)
    ) {
      return null;
    }
    return { bundleId: b, userId: u, exp: new Date(e * 1000) };
  } catch {
    return null;
  }
};

/**
 * The claims a token carries, or null when it is malformed, its MAC does not
 * verify under `secret` (compared in constant time), or it has expired.
 */
export const verifyPreviewToken = (
  secret: string,
  token: string,
  now: Date,
): PreviewTokenClaims | null => {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREVIEW_TOKEN_PREFIX) {
    return null;
  }
  const [, encodedClaims = "", mac = ""] = parts;
  if (!digestsMatch(mac, previewTokenMac(secret, encodedClaims))) {
    return null;
  }
  const claims = decodeClaims(encodedClaims);
  if (!claims || claims.exp.getTime() <= now.getTime()) {
    return null;
  }
  return claims;
};

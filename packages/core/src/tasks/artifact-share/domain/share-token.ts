import { createHmac } from "node:crypto";
import { digestsMatch } from "@scarn/core/connections/managed-mcp-connection/domain/managed-oauth-digests";
import { isUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";

/**
 * Share-link tokens (plan decision 11): `<shareId>.<mac>` where
 * `mac = HMAC-SHA256(ARTIFACT_SHARE_SECRET, shareId)`, base64url. Nothing
 * secret is stored, so the server can rebuild a link at any time; rotating
 * the secret invalidates every link.
 */
const shareTokenMac = (secret: string, shareId: string): string =>
  createHmac("sha256", secret).update(shareId).digest("base64url");

export const buildShareToken = (secret: string, shareId: UuidV7): string =>
  `${shareId}.${shareTokenMac(secret, shareId)}`;

/**
 * The share id a token names, or null when the token is malformed or its MAC
 * does not verify under `secret` (compared in constant time).
 */
export const verifyShareToken = (
  secret: string,
  token: string,
): UuidV7 | null => {
  const separator = token.indexOf(".");
  if (separator <= 0) {
    return null;
  }
  const shareId = token.slice(0, separator);
  if (!isUuidV7(shareId)) {
    return null;
  }
  const mac = token.slice(separator + 1);
  return digestsMatch(mac, shareTokenMac(secret, shareId)) ? shareId : null;
};

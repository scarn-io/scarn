import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * One-way digests of the values that bind an authorization attempt to the
 * browser that started it. Only digests are stored: the plaintext `state`
 * travels through the provider and the browser session ID stays in its
 * cookie.
 */
const digest = (label: string, value: string): string =>
  createHash("sha256").update(`${label}|${value}`).digest("base64url");

export const managedOAuthStateDigest = (state: string): string =>
  digest("managed-oauth-state:v1", state);

/** `sessionId` is the identity session's ID, which is stable for the cookie's lifetime. */
export const managedOAuthBrowserSessionDigest = (sessionId: string): string =>
  digest("managed-oauth-session:v1", sessionId);

/** `secret` is the completion secret a loopback attempt hands the CLI once. */
export const managedOAuthCompletionSecretDigest = (secret: string): string =>
  digest("managed-oauth-completion:v1", secret);

export const digestsMatch = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** 256 bits of randomness, base64url: used for `state` and the PKCE verifier (43 chars). */
export const randomOAuthToken = (): string =>
  randomBytes(32).toString("base64url");

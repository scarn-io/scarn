/**
 * Signs compact HS256 JWTs with WebCrypto. Segments are base64url without
 * padding. Verification lives in `apps/work-signal/src/hs256.ts`.
 */
export type Hs256Claims = Record<string, string | number>;

const encoder = new TextEncoder();

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const encodeJsonSegment = (value: Hs256Claims): string =>
  toBase64Url(encoder.encode(JSON.stringify(value)));

export const signHs256Jwt = async (
  claims: Hs256Claims,
  secret: string,
): Promise<string> => {
  const signingInput = `${encodeJsonSegment({ alg: "HS256", typ: "JWT" })}.${encodeJsonSegment(claims)}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`;
};

/**
 * Verifies compact HS256 JWTs with WebCrypto and returns the decoded payload
 * object, or `null` for anything malformed or wrongly signed. Callers check
 * the claims themselves. Signing lives in `packages/core/src/lib/hs256.ts`.
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function verifyHs256Jwt(
  token: string,
  secret: string,
): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts as [
    string,
    string,
    string,
  ];

  const header = parseJsonSegment(headerPart);
  if (header?.["alg"] !== "HS256") return null;

  const signature = decodeBase64Url(signaturePart);
  if (!signature) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    encoder.encode(`${headerPart}.${payloadPart}`),
  );
  if (!valid) return null;

  return parseJsonSegment(payloadPart);
}

function parseJsonSegment(segment: string): Record<string, unknown> | null {
  const bytes = decodeBase64Url(segment);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function decodeBase64Url(segment: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) return null;
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

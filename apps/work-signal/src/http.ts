const encoder = new TextEncoder();

/** Constant-time check of an `Authorization: Bearer <secret>` header. */
export function bearerMatches(header: string, secret: string): boolean {
  if (!secret) return false;
  const expected = encoder.encode(`Bearer ${secret}`);
  const actual = encoder.encode(header);
  if (expected.byteLength !== actual.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < expected.byteLength; i++) {
    diff |= (expected[i] ?? 0) ^ (actual[i] ?? 0);
  }
  return diff === 0;
}

export function methodNotAllowed(allow: string): Response {
  return new Response("Method not allowed", {
    status: 405,
    headers: { Allow: allow },
  });
}

import { beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { ACCESS_JWT_AUDIENCE } from "@/lib/access-jwt";
import { createIdentityAuth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { authJwks } from "@/lib/db/schema";
import { createTestUserAndSession } from "./helpers/create-test-user-and-session";
import { removeUndecryptableSigningKeys } from "./helpers/access-jwt-signing-keys";
import { createAuthRequest, readJson } from "./helpers/auth-test-helpers";

const authBaseUrl = process.env["BETTER_AUTH_URL"] ?? "http://localhost";

type DecodedJwt = {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Uint8Array<ArrayBuffer>;
};

const decodeSegment = (segment: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;

const decodeJwt = (token: string): DecodedJwt => {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) {
    throw new Error(`not a JWT: ${token}`);
  }

  return {
    header: decodeSegment(header),
    payload: decodeSegment(payload),
    signingInput: `${header}.${payload}`,
    signature: new Uint8Array(Buffer.from(signature, "base64url")),
  };
};

const requestToken = async (
  auth: ReturnType<typeof createIdentityAuth>,
  authorization?: string,
): Promise<Response> =>
  auth.handler(
    createAuthRequest("/token", {
      method: "GET",
      headers: authorization ? { authorization } : {},
    }),
  );

const mintToken = async (
  auth: ReturnType<typeof createIdentityAuth>,
  authorization: string,
): Promise<DecodedJwt> => {
  const response = await requestToken(auth, authorization);
  expect(response.status).toBe(200);
  const body = await readJson<{ token: string }>(response);

  return decodeJwt(body.token);
};

const findSigningJwk = async (token: DecodedJwt) => {
  const kid = token.header["kid"];
  if (typeof kid !== "string") throw new Error("token has no kid");
  const [row] = await getDb()
    .select()
    .from(authJwks)
    .where(eq(authJwks.id, kid))
    .limit(1);
  if (!row) throw new Error(`no stored key for kid ${kid}`);

  return row;
};

const verifySignature = async (
  publicKeyJson: string,
  token: DecodedJwt,
): Promise<boolean> => {
  const key = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(publicKeyJson) as JsonWebKey,
    { name: "Ed25519" },
    false,
    ["verify"],
  );

  return crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    token.signature,
    new TextEncoder().encode(token.signingInput),
  );
};

/**
 * These tests share the global `identity.jwks` table (and one deletes from
 * it), so they run serially. Keys another secret wrote are cleared first, so
 * the plugin signs with a key this run can decrypt.
 */
describe("GET /api/auth/token", () => {
  beforeEach(removeUndecryptableSigningKeys);

  test("issues an EdDSA token signed by a stored key, with the access claims", async () => {
    const auth = createIdentityAuth();
    const username = `jwt-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const user = await createTestUserAndSession({
      username,
      name: "JWT Claims",
    });

    const token = await mintToken(auth, user.authHeaders.authorization);

    expect(token.header["alg"]).toBe("EdDSA");
    const row = await findSigningJwk(token);
    expect(await verifySignature(row.publicKey, token)).toBe(true);

    const { payload } = token;
    expect(payload["sub"]).toBe(user.userId);
    expect(payload["email"]).toEqual(expect.any(String));
    expect(payload["name"]).toBe("JWT Claims");
    expect(payload["username"]).toBe(username);
    expect(payload["usernameChosen"]).toBe(true);
    expect(payload["iss"]).toBe(authBaseUrl);
    expect(payload["aud"]).toBe(ACCESS_JWT_AUDIENCE);
    expect(typeof payload["iat"]).toBe("number");
    expect(payload["exp"]).toBe((payload["iat"] as number) + 15 * 60);
    expect(Object.keys(payload).sort()).toEqual(
      [
        "aud",
        "email",
        "exp",
        "iat",
        "iss",
        "name",
        "sub",
        "username",
        "usernameChosen",
      ].sort(),
    );
  });

  test("carries a null username for a user who has not chosen one", async () => {
    const auth = createIdentityAuth();
    const user = await createTestUserAndSession({ username: null });

    const { payload } = await mintToken(auth, user.authHeaders.authorization);

    expect(payload["username"]).toBeNull();
    expect(payload["usernameChosen"]).toBe(false);
  });

  test("reuses the same signing key across calls", async () => {
    const auth = createIdentityAuth();
    const user = await createTestUserAndSession();

    const first = await mintToken(auth, user.authHeaders.authorization);
    const second = await mintToken(auth, user.authHeaders.authorization);

    expect(second.header["kid"]).toBe(first.header["kid"]);
  });

  test("rejects a request without a session", async () => {
    const auth = createIdentityAuth();

    const response = await requestToken(auth);

    expect(response.status).toBe(401);
  });

  test("does not set a set-auth-jwt header on get-session", async () => {
    const auth = createIdentityAuth();
    const user = await createTestUserAndSession();

    const response = await auth.handler(
      createAuthRequest("/get-session", {
        method: "GET",
        headers: user.authHeaders,
      }),
    );

    expect(response.status).toBe(200);
    expect(await readJson<{ user: { id: string } }>(response)).toMatchObject({
      user: { id: user.userId },
    });
    expect(response.headers.get("set-auth-jwt")).toBeNull();
  });

  test("creates and signs with a new key after the signing key is deleted", async () => {
    const auth = createIdentityAuth();
    const user = await createTestUserAndSession();
    const before = await mintToken(auth, user.authHeaders.authorization);

    await getDb()
      .delete(authJwks)
      .where(eq(authJwks.id, before.header["kid"] as string));

    const after = await mintToken(auth, user.authHeaders.authorization);

    expect(after.header["kid"]).not.toBe(before.header["kid"]);
    const row = await findSigningJwk(after);
    expect(await verifySignature(row.publicKey, after)).toBe(true);
  });
});

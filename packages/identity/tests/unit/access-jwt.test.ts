import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  ACCESS_JWT_AUDIENCE,
  ACCESS_JWT_KEY_GRACE_PERIOD_SECONDS,
  createAccessJwtVerifier,
  isJwtShaped,
  type AccessJwtKeyRecord,
} from "@/lib/access-jwt";

const ISSUER = "http://localhost:3000";
const START_MS = Date.UTC(2026, 10, 18, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

type SigningKey = {
  kid: string;
  privateKey: CryptoKey;
  record: AccessJwtKeyRecord;
};

const createSigningKey = async (
  overrides: Partial<AccessJwtKeyRecord> = {},
  publicJwkExtras: Record<string, unknown> = {},
): Promise<SigningKey> => {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const kid = overrides.id ?? randomUUID();

  return {
    kid,
    privateKey: pair.privateKey,
    record: {
      id: kid,
      publicKey: JSON.stringify({ ...publicJwk, ...publicJwkExtras }),
      alg: "EdDSA",
      expiresAt: null,
      ...overrides,
    },
  };
};

const encodeSegment = (value: Record<string, unknown>): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const defaultPayload = (nowMs: number) => ({
  sub: "0193d4a0-0000-7000-8000-000000000001",
  email: "pam@example.com",
  name: "Pam Beesly",
  username: "pam",
  usernameChosen: true,
  iss: ISSUER,
  aud: ACCESS_JWT_AUDIENCE,
  iat: Math.floor(nowMs / 1000),
  exp: Math.floor(nowMs / 1000) + 15 * 60,
});

const signToken = async (
  key: SigningKey,
  {
    header = {},
    payload = {},
    nowMs = START_MS,
  }: {
    header?: Record<string, unknown>;
    payload?: Record<string, unknown>;
    nowMs?: number;
  } = {},
): Promise<string> => {
  const signingInput = `${encodeSegment({
    alg: "EdDSA",
    kid: key.kid,
    ...header,
  })}.${encodeSegment({ ...defaultPayload(nowMs), ...payload })}`;
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    key.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
};

const createHarness = (initialKeys: SigningKey[]) => {
  let rows = initialKeys.map((key) => key.record);
  let nowMs = START_MS;
  let loads = 0;
  const verifier = createAccessJwtVerifier({
    issuer: ISSUER,
    now: () => nowMs,
    loadKeys: () => {
      loads += 1;
      return Promise.resolve([...rows]);
    },
  });

  return {
    verifier,
    loads: () => loads,
    setRows: (keys: SigningKey[]) => {
      rows = keys.map((key) => key.record);
    },
    advance: (ms: number) => {
      nowMs += ms;
    },
    now: () => nowMs,
  };
};

const replaceSegment = (token: string, index: number, value: string) => {
  const parts = token.split(".");
  parts[index] = value;
  return parts.join(".");
};

describe("isJwtShaped", () => {
  test("accepts three non-empty dot-separated parts", () => {
    expect(isJwtShaped("a.b.c")).toBe(true);
  });

  test("rejects session tokens and malformed values", () => {
    expect(isJwtShaped("abcdefghijklmnopqrstuvwxyz012345")).toBe(false);
    expect(isJwtShaped("token.signature")).toBe(false);
    expect(isJwtShaped("a..c")).toBe(false);
    expect(isJwtShaped("a.b.c.d")).toBe(false);
    expect(isJwtShaped("")).toBe(false);
  });
});

describe("createAccessJwtVerifier", () => {
  test("verifies a valid token and returns the user from its claims", async () => {
    const key = await createSigningKey();
    const { verifier } = createHarness([key]);

    const result = await verifier.verify(await signToken(key));

    expect(result).toEqual({
      userId: "0193d4a0-0000-7000-8000-000000000001",
      user: {
        id: "0193d4a0-0000-7000-8000-000000000001",
        email: "pam@example.com",
        name: "Pam Beesly",
        username: "pam",
        usernameChosen: true,
      },
    });
  });

  test("rejects an expired token", async () => {
    const key = await createSigningKey();
    const harness = createHarness([key]);
    const token = await signToken(key);

    harness.advance(15 * 60 * 1000 + 31 * 1000);

    expect(await harness.verifier.verify(token)).toBeNull();
  });

  test("accepts a token that expired within the clock-skew window", async () => {
    const key = await createSigningKey();
    const harness = createHarness([key]);
    const token = await signToken(key);

    harness.advance(15 * 60 * 1000 + 29 * 1000);

    expect(await harness.verifier.verify(token)).not.toBeNull();
  });

  test("rejects a token for another audience", async () => {
    const key = await createSigningKey();
    const { verifier } = createHarness([key]);

    const token = await signToken(key, { payload: { aud: "other-api" } });

    expect(await verifier.verify(token)).toBeNull();
  });

  test("rejects a token from another issuer", async () => {
    const key = await createSigningKey();
    const { verifier } = createHarness([key]);

    const token = await signToken(key, {
      payload: { iss: "https://evil.example.com" },
    });

    expect(await verifier.verify(token)).toBeNull();
  });

  test('rejects alg "none"', async () => {
    const key = await createSigningKey();
    const { verifier } = createHarness([key]);
    const valid = await signToken(key);
    const [, payload] = valid.split(".");
    if (!payload) throw new Error(`not a JWT: ${valid}`);

    const token = `${encodeSegment({ alg: "none", kid: key.kid })}.${payload}.AA`;

    expect(await verifier.verify(token)).toBeNull();
  });

  test("rejects a tampered payload", async () => {
    const key = await createSigningKey();
    const { verifier } = createHarness([key]);
    const valid = await signToken(key);

    const token = replaceSegment(
      valid,
      1,
      encodeSegment({
        ...defaultPayload(START_MS),
        email: "admin@example.com",
      }),
    );

    expect(await verifier.verify(token)).toBeNull();
  });

  test("rejects a tampered signature", async () => {
    const key = await createSigningKey();
    const { verifier } = createHarness([key]);
    const valid = await signToken(key);
    const [, , signatureSegment] = valid.split(".");
    if (!signatureSegment) throw new Error(`not a JWT: ${valid}`);
    const signature = Buffer.from(signatureSegment, "base64url");
    signature.writeUInt8(signature.readUInt8(0) ^ 0xff, 0);

    const token = replaceSegment(valid, 2, signature.toString("base64url"));

    expect(await verifier.verify(token)).toBeNull();
  });

  test("rejects a token whose claims do not match the schema", async () => {
    const key = await createSigningKey();
    const { verifier } = createHarness([key]);

    const token = await signToken(key, { payload: { usernameChosen: "yes" } });

    expect(await verifier.verify(token)).toBeNull();
  });

  test("accepts a key past expiresAt but inside the grace period", async () => {
    const key = await createSigningKey({
      expiresAt: new Date(
        START_MS - (ACCESS_JWT_KEY_GRACE_PERIOD_SECONDS * 1000 - DAY_MS),
      ),
    });
    const { verifier } = createHarness([key]);

    expect(await verifier.verify(await signToken(key))).not.toBeNull();
  });

  test("rejects a key past the grace period", async () => {
    const key = await createSigningKey({
      expiresAt: new Date(
        START_MS - (ACCESS_JWT_KEY_GRACE_PERIOD_SECONDS * 1000 + DAY_MS),
      ),
    });
    const { verifier } = createHarness([key]);

    expect(await verifier.verify(await signToken(key))).toBeNull();
  });

  test("loads keys once across many calls", async () => {
    const key = await createSigningKey();
    const harness = createHarness([key]);
    const token = await signToken(key);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => harness.verifier.verify(token)),
    );
    await harness.verifier.verify(token);

    expect(results.every((result) => result !== null)).toBe(true);
    expect(harness.loads()).toBe(1);
  });

  test("reloads once for an unknown kid, then not again within 10 seconds", async () => {
    const first = await createSigningKey();
    const second = await createSigningKey();
    const harness = createHarness([first]);
    await harness.verifier.verify(await signToken(first));
    expect(harness.loads()).toBe(1);

    harness.advance(11_000);
    harness.setRows([first, second]);
    expect(
      await harness.verifier.verify(
        await signToken(second, {
          nowMs: harness.now(),
        }),
      ),
    ).not.toBeNull();
    expect(harness.loads()).toBe(2);

    harness.advance(5_000);
    const unknown = await createSigningKey();
    expect(
      await harness.verifier.verify(
        await signToken(unknown, {
          nowMs: harness.now(),
        }),
      ),
    ).toBeNull();
    expect(harness.loads()).toBe(2);

    harness.advance(6_000);
    expect(
      await harness.verifier.verify(
        await signToken(unknown, {
          nowMs: harness.now(),
        }),
      ),
    ).toBeNull();
    expect(harness.loads()).toBe(3);
  });

  test("a fresh verifier rejects a key that was deleted", async () => {
    const key = await createSigningKey();
    const running = createHarness([key]);
    const token = await signToken(key);
    expect(await running.verifier.verify(token)).not.toBeNull();

    running.setRows([]);
    expect(await running.verifier.verify(token)).not.toBeNull();

    const fresh = createHarness([]);
    expect(await fresh.verifier.verify(token)).toBeNull();
  });

  test('imports a stored JWK whose alg is "Ed25519"', async () => {
    const key = await createSigningKey(
      {},
      { alg: "Ed25519", key_ops: ["verify"] },
    );
    const { verifier } = createHarness([key]);

    expect(await verifier.verify(await signToken(key))).not.toBeNull();
  });
});

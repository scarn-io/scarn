/**
 * Shared definitions for the short-lived access JWTs issued by Better Auth's
 * `jwt()` plugin at `GET /api/auth/token` and verified by the API. The plugin
 * config (`auth.ts`) and the verifier both build on these, so the claims a
 * token carries and the claims the API accepts cannot drift apart.
 *
 * The verifier keeps imported public keys in memory for the life of the
 * isolate, so a request carrying a JWT costs one signature check and no
 * database query once the keys are loaded.
 */
import { z } from "zod";
import { currentDb } from "./db";
import { authJwks } from "./db/schema";
import { getBetterAuthBaseUrl } from "./env";

export const ACCESS_JWT_AUDIENCE = "scarn-api";

/**
 * How long a signing key keeps verifying after its `expiresAt`. Matches the
 * `jwt()` plugin's default `jwks.gracePeriod`, which is left unset.
 */
export const ACCESS_JWT_KEY_GRACE_PERIOD_SECONDS = 60 * 60 * 24 * 30;

export const ACCESS_JWT_CLOCK_SKEW_SECONDS = 30;

export const ACCESS_JWT_KEY_RELOAD_INTERVAL_MS = 10_000;

/**
 * The narrow user an authenticated API request carries, filled from an access
 * JWT's claims or from a session. Distinct from the full `AuthUser` contract.
 */
export type AuthenticatedUser = {
  id: string;
  email: string;
  name: string;
  username: string | null;
  usernameChosen: boolean;
};

export const accessClaimsSchema = z.object({
  sub: z.string().min(1),
  email: z.string(),
  name: z.string(),
  username: z.string().nullable(),
  usernameChosen: z.boolean(),
});

export type AccessClaims = z.infer<typeof accessClaimsSchema>;

type AccessClaimsSource = {
  id: string;
  email: string;
  name: string;
  username?: unknown;
  usernameChosen?: unknown;
};

export const toAccessClaims = (user: AccessClaimsSource): AccessClaims => ({
  sub: user.id,
  email: user.email,
  name: user.name,
  username: typeof user.username === "string" ? user.username : null,
  usernameChosen: user.usernameChosen === true,
});

/** A row of `identity.jwks`, as the verifier needs it. */
export type AccessJwtKeyRecord = {
  id: string;
  publicKey: string;
  alg: string | null;
  expiresAt: Date | null;
};

export type VerifiedAccessJwt = {
  userId: string;
  user: AuthenticatedUser;
};

export type AccessJwtVerifier = {
  verify: (token: string) => Promise<VerifiedAccessJwt | null>;
};

export type AccessJwtVerifierOptions = {
  loadKeys: () => Promise<AccessJwtKeyRecord[]>;
  issuer: string;
  now?: () => number;
};

type CachedKey = {
  key: CryptoKey;
  expiresAtMs: number | null;
};

const ED25519 = { name: "Ed25519" } as const;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const isJwtShaped = (token: string): boolean => {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
};

const decodeBase64Url = (segment: string): Uint8Array<ArrayBuffer> => {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const decodeJsonSegment = (segment: string): Record<string, unknown> | null => {
  const value: unknown = JSON.parse(
    textDecoder.decode(decodeBase64Url(segment)),
  );
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
};

/**
 * workerd rejects an Ed25519 JWK whose `alg` is `"Ed25519"`, so `alg` and
 * `key_ops` are dropped before import; the algorithm and usage are given to
 * `importKey` directly.
 */
const importPublicKey = async (publicKey: string): Promise<CryptoKey> => {
  const jwk = JSON.parse(publicKey) as JsonWebKey;
  delete jwk.alg;
  delete jwk.key_ops;
  return crypto.subtle.importKey("jwk", jwk, ED25519, false, ["verify"]);
};

const hasAudience = (
  payload: Record<string, unknown>,
  audience: string,
): boolean => {
  const aud = payload["aud"];
  return aud === audience || (Array.isArray(aud) && aud.includes(audience));
};

/**
 * Builds a verifier whose key cache lives as long as the verifier: create one
 * per isolate. Keys load on the first `verify`; a token naming an unknown
 * `kid` reloads them, at most once per {@link ACCESS_JWT_KEY_RELOAD_INTERVAL_MS},
 * and concurrent callers share a load that is already running.
 */
export const createAccessJwtVerifier = ({
  loadKeys,
  issuer,
  now = Date.now,
}: AccessJwtVerifierOptions): AccessJwtVerifier => {
  let keys: Map<string, CachedKey> | null = null;
  let pendingLoad: Promise<void> | null = null;
  let lastLoadStartedAt = Number.NEGATIVE_INFINITY;

  const reload = async (): Promise<void> => {
    const records = await loadKeys();
    const next = new Map<string, CachedKey>();
    for (const record of records) {
      if (record.alg !== null && record.alg !== "EdDSA") continue;
      const existing = keys?.get(record.id);
      next.set(record.id, {
        key: existing?.key ?? (await importPublicKey(record.publicKey)),
        expiresAtMs: record.expiresAt?.getTime() ?? null,
      });
    }
    keys = next;
  };

  const load = (): Promise<void> => {
    if (!pendingLoad) {
      lastLoadStartedAt = now();
      pendingLoad = reload().finally(() => {
        pendingLoad = null;
      });
    }
    return pendingLoad;
  };

  const findKey = async (kid: string): Promise<CachedKey | undefined> => {
    if (pendingLoad || !keys) {
      await load();
      return keys?.get(kid);
    }
    const cached = keys.get(kid);
    if (cached) return cached;
    if (now() - lastLoadStartedAt < ACCESS_JWT_KEY_RELOAD_INTERVAL_MS) {
      return undefined;
    }
    await load();
    return keys.get(kid);
  };

  const isKeyUsable = (key: CachedKey): boolean =>
    key.expiresAtMs === null ||
    now() - key.expiresAtMs < ACCESS_JWT_KEY_GRACE_PERIOD_SECONDS * 1000;

  const verify = async (token: string): Promise<VerifiedAccessJwt | null> => {
    if (!isJwtShaped(token)) return null;
    const [headerSegment, payloadSegment, signatureSegment] = token.split(
      ".",
    ) as [string, string, string];

    let header: Record<string, unknown> | null;
    let payload: Record<string, unknown> | null;
    let signature: Uint8Array<ArrayBuffer>;
    try {
      header = decodeJsonSegment(headerSegment);
      payload = decodeJsonSegment(payloadSegment);
      signature = decodeBase64Url(signatureSegment);
    } catch {
      return null;
    }
    if (!header || !payload) return null;
    if (header["alg"] !== "EdDSA") return null;
    const kid = header["kid"];
    if (typeof kid !== "string" || kid.length === 0) return null;

    const key = await findKey(kid);
    if (!key || !isKeyUsable(key)) return null;

    const signatureValid = await crypto.subtle.verify(
      ED25519,
      key.key,
      signature,
      textEncoder.encode(`${headerSegment}.${payloadSegment}`),
    );
    if (!signatureValid) return null;

    if (payload["iss"] !== issuer) return null;
    if (!hasAudience(payload, ACCESS_JWT_AUDIENCE)) return null;
    const exp = payload["exp"];
    if (typeof exp !== "number") return null;
    if (now() / 1000 > exp + ACCESS_JWT_CLOCK_SKEW_SECONDS) return null;

    const claims = accessClaimsSchema.safeParse(payload);
    if (!claims.success) return null;

    const { sub, email, name, username, usernameChosen } = claims.data;
    return {
      userId: sub,
      user: { id: sub, email, name, username, usernameChosen },
    };
  };

  return { verify };
};

/** Reads the public keys through the request-scoped Drizzle client. */
export const loadAccessJwtKeys = async (): Promise<AccessJwtKeyRecord[]> =>
  currentDb
    .select({
      id: authJwks.id,
      publicKey: authJwks.publicKey,
      alg: authJwks.alg,
      expiresAt: authJwks.expiresAt,
    })
    .from(authJwks);

let defaultVerifier: AccessJwtVerifier | undefined;

/** The isolate-wide verifier the API uses, created on first use. */
export const getAccessJwtVerifier = (): AccessJwtVerifier => {
  defaultVerifier ??= createAccessJwtVerifier({
    loadKeys: loadAccessJwtKeys,
    issuer: getBetterAuthBaseUrl(),
  });
  return defaultVerifier;
};

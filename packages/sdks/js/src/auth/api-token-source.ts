import { createHash } from "node:crypto";
import {
  deleteApiTokenCacheEntry,
  loadApiTokenCacheEntry,
  saveApiTokenCacheEntry,
  type ApiTokenCacheEntry,
} from "./api-token-cache";

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * The session token is missing or the server rejected it while minting an API
 * token: the user has to log in again.
 */
export class ApiTokenAuthError extends Error {
  readonly baseUrl: string;
  readonly status: number | undefined;

  constructor(message: string, baseUrl: string, status?: number) {
    super(message);
    this.name = "ApiTokenAuthError";
    this.baseUrl = baseUrl;
    this.status = status;
  }
}

export type ApiCredential = {
  /** Full `Authorization` header value. */
  authorization: string;
  /** `session` once the server has no token endpoint (404) and the session bearer is sent instead. */
  kind: "jwt" | "session";
};

export type ApiTokenSourceOptions = {
  baseUrl: string;
  getSessionToken: () =>
    string | null | undefined | Promise<string | null | undefined>;
  fetch?: FetchLike | undefined;
};

export type ApiTokenSource = {
  getAuthorization(): Promise<string>;
  getCredential(): Promise<ApiCredential>;
  /**
   * Drops the cached token (memory and disk). With `failedAuthorization`,
   * drops it only if it is still the token that failed, so a token refreshed
   * meanwhile survives.
   */
  invalidate(failedAuthorization?: string): void;
};

const MIN_REMAINING_MS = 60_000;
const BEARER_PREFIX = "Bearer ";

const hashSessionToken = (sessionToken: string) =>
  createHash("sha256").update(sessionToken).digest("hex");

const decodeJwtExpiry = (token: string): number => {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("API token is not a JWT");
  const claims: unknown = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  );
  const exp =
    typeof claims === "object" && claims !== null
      ? (claims as Record<string, unknown>)["exp"]
      : undefined;
  if (typeof exp !== "number") throw new Error("API token has no exp claim");
  return exp * 1000;
};

const readTokenFromResponse = async (response: Response): Promise<string> => {
  const body: unknown = await response.json();
  const token =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)["token"]
      : undefined;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("API token response has no token");
  }
  return token;
};

/**
 * Supplies the `Authorization` header for API calls: a short-lived JWT minted
 * from the session token at `GET /api/auth/token`, cached in memory and in
 * `~/.scarn/api-tokens.jsonc` and reused while it has more than a minute left.
 * Servers without the token endpoint (404) get the session bearer for the
 * rest of the process.
 */
export function createApiTokenSource(
  options: ApiTokenSourceOptions,
): ApiTokenSource {
  const baseUrl = options.baseUrl;
  const tokenUrl = `${baseUrl.replace(/\/+$/, "")}/api/auth/token`;
  const fetchImpl: FetchLike = options.fetch ?? ((...args) => fetch(...args));

  let sessionFallback = false;
  let cached: ApiTokenCacheEntry | null = null;
  let inFlight: {
    sessionHash: string;
    promise: Promise<ApiCredential>;
  } | null = null;

  const isUsable = (
    entry: ApiTokenCacheEntry | null,
    sessionHash: string,
  ): entry is ApiTokenCacheEntry =>
    entry !== null &&
    entry.sessionHash === sessionHash &&
    entry.expiresAt - Date.now() > MIN_REMAINING_MS;

  const jwtCredential = (token: string): ApiCredential => ({
    authorization: `${BEARER_PREFIX}${token}`,
    kind: "jwt",
  });

  const sessionCredential = (sessionToken: string): ApiCredential => ({
    authorization: `${BEARER_PREFIX}${sessionToken}`,
    kind: "session",
  });

  const mint = async (
    sessionToken: string,
    sessionHash: string,
  ): Promise<ApiCredential> => {
    const response = await fetchImpl(tokenUrl, {
      method: "GET",
      headers: { Authorization: `${BEARER_PREFIX}${sessionToken}` },
    });
    if (response.status === 404) {
      sessionFallback = true;
      return sessionCredential(sessionToken);
    }
    if (response.status === 401) {
      throw new ApiTokenAuthError(
        "The server rejected the session token while issuing an API token",
        baseUrl,
        401,
      );
    }
    if (!response.ok) {
      throw new Error(
        `Failed to issue an API token: HTTP ${String(response.status)}`,
      );
    }
    const token = await readTokenFromResponse(response);
    const entry: ApiTokenCacheEntry = {
      sessionHash,
      token,
      expiresAt: decodeJwtExpiry(token),
    };
    cached = entry;
    try {
      saveApiTokenCacheEntry(baseUrl, entry);
    } catch {
      // The disk cache is an optimisation; the in-memory token still works.
    }
    return jwtCredential(token);
  };

  const getCredential = async (): Promise<ApiCredential> => {
    const sessionToken = await options.getSessionToken();
    if (!sessionToken) {
      throw new ApiTokenAuthError("No session token: log in first", baseUrl);
    }
    if (sessionFallback) return sessionCredential(sessionToken);

    const sessionHash = hashSessionToken(sessionToken);
    if (isUsable(cached, sessionHash)) return jwtCredential(cached.token);

    const fromDisk = loadApiTokenCacheEntry(baseUrl);
    if (isUsable(fromDisk, sessionHash)) {
      cached = fromDisk;
      return jwtCredential(fromDisk.token);
    }

    if (inFlight?.sessionHash === sessionHash) return inFlight.promise;
    const promise = mint(sessionToken, sessionHash).finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
    inFlight = { sessionHash, promise };
    return promise;
  };

  const invalidate = (failedAuthorization?: string) => {
    const failedToken =
      failedAuthorization === undefined
        ? cached?.token
        : failedAuthorization.startsWith(BEARER_PREFIX)
          ? failedAuthorization.slice(BEARER_PREFIX.length)
          : failedAuthorization;
    if (failedToken === undefined) return;
    if (cached?.token === failedToken) cached = null;
    try {
      deleteApiTokenCacheEntry(baseUrl, { onlyToken: failedToken });
    } catch {
      // A stale disk entry is rejected by the server and replaced next time.
    }
  };

  return {
    getAuthorization: async () => (await getCredential()).authorization,
    getCredential,
    invalidate,
  };
}

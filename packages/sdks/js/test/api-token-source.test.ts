import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadApiTokenCacheEntry,
  saveApiTokenCacheEntry,
} from "../src/auth/api-token-cache";
import {
  ApiTokenAuthError,
  createApiTokenSource,
  type FetchLike,
} from "../src/auth/api-token-source";
import { setHomeDirForTests } from "../src/defaults/home-dir";
import { jsonResponse, makeJwt, rejectionOf } from "./api-token-test-helpers";

const BASE_URL = "https://api.test";

let fakeHome: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "scarn-api-token-source-"));
  setHomeDirForTests(fakeHome);
});

afterEach(() => {
  setHomeDirForTests(undefined);
  rmSync(fakeHome, { recursive: true, force: true });
});

const mintingFetch = (tokens: string[]) => {
  const calls: { url: string; authorization: string | null }[] = [];
  const fetch: FetchLike = (input, init) => {
    const request = new Request(input, init);
    calls.push({
      url: request.url,
      authorization: request.headers.get("Authorization"),
    });
    const token = tokens.shift();
    if (!token) return Promise.reject(new Error("unexpected mint"));
    return Promise.resolve(jsonResponse(200, { token }));
  };
  return { fetch, calls };
};

describe("createApiTokenSource", () => {
  test("mints with the session bearer and reuses the token", async () => {
    const jwt = makeJwt(900);
    const { fetch, calls } = mintingFetch([jwt]);
    const source = createApiTokenSource({
      baseUrl: BASE_URL,
      getSessionToken: () => "session-1",
      fetch,
    });

    expect(await source.getAuthorization()).toBe(`Bearer ${jwt}`);
    expect(await source.getAuthorization()).toBe(`Bearer ${jwt}`);
    expect(calls).toEqual([
      {
        url: `${BASE_URL}/api/auth/token`,
        authorization: "Bearer session-1",
      },
    ]);
  });

  test("reuses a token cached on disk by another process", async () => {
    const jwt = makeJwt(900);
    const first = mintingFetch([jwt]);
    await createApiTokenSource({
      baseUrl: BASE_URL,
      getSessionToken: () => "session-1",
      fetch: first.fetch,
    }).getAuthorization();

    const second = mintingFetch([]);
    const source = createApiTokenSource({
      baseUrl: BASE_URL,
      getSessionToken: () => "session-1",
      fetch: second.fetch,
    });
    expect(await source.getAuthorization()).toBe(`Bearer ${jwt}`);
    expect(second.calls).toHaveLength(0);
  });

  test("refreshes a token with 60 seconds or less left", async () => {
    const nearExpiry = makeJwt(60, "old");
    const fresh = makeJwt(900, "new");
    const { fetch, calls } = mintingFetch([nearExpiry, fresh]);
    const source = createApiTokenSource({
      baseUrl: BASE_URL,
      getSessionToken: () => "session-1",
      fetch,
    });

    expect(await source.getAuthorization()).toBe(`Bearer ${nearExpiry}`);
    expect(await source.getAuthorization()).toBe(`Bearer ${fresh}`);
    expect(calls).toHaveLength(2);
    expect(loadApiTokenCacheEntry(BASE_URL)?.token).toBe(fresh);
  });

  test("ignores a cached token minted from another session token", async () => {
    saveApiTokenCacheEntry(BASE_URL, {
      sessionHash: "not-this-session",
      token: makeJwt(900, "stale"),
      expiresAt: Date.now() + 900_000,
    });
    const fresh = makeJwt(900, "fresh");
    const after = makeJwt(900, "after");
    let sessionToken = "session-1";
    const { fetch, calls } = mintingFetch([fresh, after]);
    const source = createApiTokenSource({
      baseUrl: BASE_URL,
      getSessionToken: () => sessionToken,
      fetch,
    });

    expect(await source.getAuthorization()).toBe(`Bearer ${fresh}`);
    sessionToken = "session-2";
    expect(await source.getAuthorization()).toBe(`Bearer ${after}`);
    expect(calls.map((c) => c.authorization)).toEqual([
      "Bearer session-1",
      "Bearer session-2",
    ]);
  });

  test("concurrent callers share one mint", async () => {
    const jwt = makeJwt(900);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let mints = 0;
    const source = createApiTokenSource({
      baseUrl: BASE_URL,
      getSessionToken: () => "session-1",
      fetch: async () => {
        mints += 1;
        await gate;
        return jsonResponse(200, { token: jwt });
      },
    });

    const results = Promise.all([
      source.getAuthorization(),
      source.getAuthorization(),
      source.getAuthorization(),
    ]);
    release();
    expect(await results).toEqual([
      `Bearer ${jwt}`,
      `Bearer ${jwt}`,
      `Bearer ${jwt}`,
    ]);
    expect(mints).toBe(1);
  });

  test("falls back to the session bearer for good after a 404", async () => {
    let mints = 0;
    const source = createApiTokenSource({
      baseUrl: BASE_URL,
      getSessionToken: () => "session-1",
      fetch: () => {
        mints += 1;
        return Promise.resolve(jsonResponse(404));
      },
    });

    expect(await source.getCredential()).toEqual({
      authorization: "Bearer session-1",
      kind: "session",
    });
    expect(await source.getAuthorization()).toBe("Bearer session-1");
    expect(mints).toBe(1);
    expect(loadApiTokenCacheEntry(BASE_URL)).toBeNull();
  });

  test("a 401 while minting is an auth error", async () => {
    const source = createApiTokenSource({
      baseUrl: BASE_URL,
      getSessionToken: () => "session-1",
      fetch: () => Promise.resolve(jsonResponse(401)),
    });
    const error = await rejectionOf(source.getAuthorization());
    expect(error).toBeInstanceOf(ApiTokenAuthError);
  });

  test("a missing session token is an auth error", async () => {
    const source = createApiTokenSource({
      baseUrl: BASE_URL,
      getSessionToken: () => null,
      fetch: () => Promise.resolve(jsonResponse(200, { token: makeJwt(900) })),
    });
    const error = await rejectionOf(source.getAuthorization());
    expect(error).toBeInstanceOf(ApiTokenAuthError);
  });

  test("other mint failures throw a generic error with the status", async () => {
    const source = createApiTokenSource({
      baseUrl: BASE_URL,
      getSessionToken: () => "session-1",
      fetch: () => Promise.resolve(jsonResponse(503)),
    });
    const error = await rejectionOf(source.getAuthorization());
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ApiTokenAuthError);
    expect(error.message).toContain("503");
  });

  test("invalidate drops the token from memory and disk", async () => {
    const first = makeJwt(900, "first");
    const second = makeJwt(900, "second");
    const { fetch } = mintingFetch([first, second]);
    const source = createApiTokenSource({
      baseUrl: BASE_URL,
      getSessionToken: () => "session-1",
      fetch,
    });

    await source.getAuthorization();
    source.invalidate(`Bearer ${first}`);
    expect(loadApiTokenCacheEntry(BASE_URL)).toBeNull();
    expect(await source.getAuthorization()).toBe(`Bearer ${second}`);
  });

  test("invalidate leaves a token that was refreshed meanwhile", async () => {
    const current = makeJwt(900, "current");
    const { fetch } = mintingFetch([current]);
    const source = createApiTokenSource({
      baseUrl: BASE_URL,
      getSessionToken: () => "session-1",
      fetch,
    });

    await source.getAuthorization();
    source.invalidate(`Bearer ${makeJwt(900, "older")}`);
    expect(loadApiTokenCacheEntry(BASE_URL)?.token).toBe(current);
    expect(await source.getAuthorization()).toBe(`Bearer ${current}`);
  });
});

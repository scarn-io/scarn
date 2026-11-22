/**
 * End to end: the CLI's authenticated client (what `connectApi` in
 * `apps/cli/src/lib/cli-api-client.ts` builds) against the real API served on
 * an ephemeral port. A saved session in a scratch `~/.scarn/auth.jsonc` is
 * exchanged once at `GET /api/auth/token`; the JWT is cached in
 * `~/.scarn/api-tokens.jsonc` and reused, including by a second client built
 * from scratch, the way the next CLI invocation would.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@scarn/api/app";
import {
  createApiTokenSource,
  createAuthenticatedFetch,
  getApiTokenCacheFilePath,
  type ApiTokenCacheEntry,
  type FetchLike,
} from "@scarn/sdk/auth";
import { createScarnClient } from "@scarn/sdk/client";
import { removeUndecryptableSigningKeys } from "@scarn/identity/testing/access-jwt-signing-keys";
import { saveAuthProfile, setHomeDirForTests } from "@scarn/sdk/defaults";
import { loadAuthenticatedSession } from "@scarn/worker";
import { createAppContext } from "@/lib/di";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";

describe("CLI API tokens against a local API", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  let home: string;
  const requests: Array<{ path: string; authorization: string | null }> = [];

  const countingFetch: FetchLike = async (input, init) => {
    const request = new Request(input, init);
    requests.push({
      path: new URL(request.url).pathname,
      authorization: request.headers.get("Authorization"),
    });
    return fetch(request);
  };

  const connect = async () => {
    const authenticated = await loadAuthenticatedSession(baseUrl);
    if (!authenticated) throw new Error("expected a saved session");
    const authenticatedFetch = createAuthenticatedFetch(
      createApiTokenSource({
        baseUrl,
        getSessionToken: () => authenticated.profile.accessToken,
        fetch: countingFetch,
      }),
      { fetch: countingFetch },
    );
    return createScarnClient(baseUrl, { fetch: authenticatedFetch });
  };

  const mints = () =>
    requests.filter((request) => request.path === "/api/auth/token");

  beforeAll(async () => {
    await removeUndecryptableSigningKeys();
    const app = createApp(createAppContext());
    server = Bun.serve({ port: 0, fetch: (request) => app.handle(request) });
    baseUrl = `http://localhost:${String(server.port)}`;

    home = mkdtempSync(join(tmpdir(), "scarn-cli-api-token-"));
    setHomeDirForTests(home);
    const owner = await createTestUserAndSession();
    saveAuthProfile(baseUrl, { accessToken: owner.sessionToken });
  });

  afterAll(async () => {
    setHomeDirForTests(undefined);
    rmSync(home, { recursive: true, force: true });
    await server.stop(true);
  });

  test("mints one API token, caches it on disk and reuses it", async () => {
    const first = await (await connect()).projects.listProjects();
    expect(first.error).toBeUndefined();
    expect(first.response.status).toBe(200);
    expect(mints()).toHaveLength(1);

    const cache = JSON.parse(
      readFileSync(getApiTokenCacheFilePath(), "utf8"),
    ) as { tokens: Record<string, ApiTokenCacheEntry> };
    const entry = cache.tokens[baseUrl];
    if (!entry) throw new Error(`expected a cached API token for ${baseUrl}`);
    expect(entry.token.split(".")).toHaveLength(3);
    expect(entry.expiresAt).toBeGreaterThan(Date.now());

    const listCall = requests.find((r) => r.path === "/api/projects");
    expect(listCall?.authorization).toBe(`Bearer ${entry.token}`);

    const second = await (await connect()).projects.listProjects();
    expect(second.error).toBeUndefined();
    expect(second.response.status).toBe(200);
    expect(mints()).toHaveLength(1);
  });
});

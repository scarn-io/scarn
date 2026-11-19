import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createApiTokenSource,
  type FetchLike,
} from "../src/auth/api-token-source";
import { createAuthenticatedFetch } from "../src/auth/authenticated-fetch";
import { createScarnClient } from "../src/client";
import { setHomeDirForTests } from "../src/defaults/home-dir";
import { jsonResponse, makeJwt } from "./api-token-test-helpers";

const BASE_URL = "https://api.test";

let fakeHome: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "scarn-authenticated-fetch-"));
  setHomeDirForTests(fakeHome);
});

afterEach(() => {
  setHomeDirForTests(undefined);
  rmSync(fakeHome, { recursive: true, force: true });
});

type SeenRequest = {
  method: string;
  url: string;
  authorization: string | null;
  body: string;
};

/**
 * A fake server: `/api/auth/token` hands out `mintable` tokens in order (or
 * 404s when `mintable` is null), and every other request is answered by
 * `respond`, which sees the request's Authorization header.
 */
const fakeServer = (options: {
  mintable: string[] | null;
  respond: (authorization: string | null) => Response;
}) => {
  const apiRequests: SeenRequest[] = [];
  let mints = 0;
  const fetch: FetchLike = async (input, init) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/api/auth/token")) {
      mints += 1;
      if (options.mintable === null) return jsonResponse(404);
      const token = options.mintable.shift();
      if (!token) throw new Error("unexpected mint");
      return jsonResponse(200, { token });
    }
    const authorization = request.headers.get("Authorization");
    apiRequests.push({
      method: request.method,
      url: request.url,
      authorization,
      body: await request.text(),
    });
    return options.respond(authorization);
  };
  return { fetch, apiRequests, mints: () => mints };
};

const build = (server: ReturnType<typeof fakeServer>) => {
  const source = createApiTokenSource({
    baseUrl: BASE_URL,
    getSessionToken: () => "session-1",
    fetch: server.fetch,
  });
  return createAuthenticatedFetch(source, { fetch: server.fetch });
};

describe("createAuthenticatedFetch", () => {
  test("sends the JWT as the bearer", async () => {
    const jwt = makeJwt(900);
    const server = fakeServer({
      mintable: [jwt],
      respond: () => jsonResponse(200, { ok: true }),
    });

    const response = await build(server)(`${BASE_URL}/api/things`);
    expect(response.status).toBe(200);
    expect(server.apiRequests[0]?.authorization).toBe(`Bearer ${jwt}`);
  });

  test("retries a 401 once with a new token, resending the POST body", async () => {
    const stale = makeJwt(900, "stale");
    const fresh = makeJwt(900, "fresh");
    const server = fakeServer({
      mintable: [stale, fresh],
      respond: (authorization) =>
        authorization === `Bearer ${fresh}`
          ? jsonResponse(201, { ok: true })
          : jsonResponse(401),
    });

    const response = await build(server)(`${BASE_URL}/api/things`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });

    expect(response.status).toBe(201);
    expect(server.apiRequests).toEqual([
      {
        method: "POST",
        url: `${BASE_URL}/api/things`,
        authorization: `Bearer ${stale}`,
        body: '{"name":"x"}',
      },
      {
        method: "POST",
        url: `${BASE_URL}/api/things`,
        authorization: `Bearer ${fresh}`,
        body: '{"name":"x"}',
      },
    ]);
  });

  test("returns a second 401 to the caller without retrying again", async () => {
    const server = fakeServer({
      mintable: [makeJwt(900, "a"), makeJwt(900, "b")],
      respond: () => jsonResponse(401),
    });

    const response = await build(server)(`${BASE_URL}/api/things`);
    expect(response.status).toBe(401);
    expect(server.apiRequests).toHaveLength(2);
    expect(server.mints()).toBe(2);
  });

  test("does not retry a 401 sent with the session bearer fallback", async () => {
    const server = fakeServer({
      mintable: null,
      respond: () => jsonResponse(401),
    });

    const response = await build(server)(`${BASE_URL}/api/things`);
    expect(response.status).toBe(401);
    expect(server.apiRequests).toEqual([
      {
        method: "GET",
        url: `${BASE_URL}/api/things`,
        authorization: "Bearer session-1",
        body: "",
      },
    ]);
  });

  test("works as the generated client's fetch", async () => {
    const jwt = makeJwt(900);
    const server = fakeServer({
      mintable: [jwt],
      respond: () => jsonResponse(200, {}),
    });
    const client = createScarnClient(BASE_URL, { fetch: build(server) });

    await client.projects.listProjects();
    expect(server.apiRequests[0]).toMatchObject({
      url: `${BASE_URL}/api/projects`,
      authorization: `Bearer ${jwt}`,
    });
  });
});

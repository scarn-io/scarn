/**
 * Unit tests for {@link CredentialRelayServer} over real HTTP on loopback:
 * auth, routing, body limit, protocol errors and the `get` round trip.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CredentialRelay } from "../../../../src/runtime/git-credentials/application/credential-relay";
import { GitCredentialPolicy } from "../../../../src/runtime/git-credentials/domain/git-credential-policy";
import {
  CredentialRelayServer,
  MAX_CREDENTIAL_REQUEST_BYTES,
} from "../../../../src/runtime/git-credentials/infra";

const TOKEN = "relay-test-token-0123456789abcdef";
const PASSWORD = "ghs_serverSecret0123456789";
const GET_BODY = "protocol=https\nhost=github.com\npath=acme/app.git\n\n";

let server: CredentialRelayServer;
let baseUrl: string;

beforeEach(async () => {
  const relay = new CredentialRelay({
    policy: GitCredentialPolicy.forRepo({
      repoGitUrl: "https://github.com/acme/app.git",
      extraHosts: [],
    }),
    source: {
      mode: "host",
      get: () =>
        Promise.resolve({
          username: "octo",
          password: PASSWORD,
          expiresAt: null,
        }),
    },
    audit: () => {},
    onSecretValues: () => {},
  });
  server = new CredentialRelayServer({
    relay,
    token: TOKEN,
    bindAddress: "127.0.0.1",
  });
  baseUrl = `http://127.0.0.1:${String(await server.start())}`;
});

afterEach(async () => {
  await server.stop();
});

function post(
  pathname: string,
  body: string,
  authorization: string | null = `Bearer ${TOKEN}`,
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "text/plain" };
  if (authorization !== null) {
    headers["Authorization"] = authorization;
  }
  return fetch(`${baseUrl}${pathname}`, { method: "POST", headers, body });
}

describe("CredentialRelayServer", () => {
  test("answers a get with the credential", async () => {
    const response = await post("/credentials/git/get", GET_BODY);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`username=octo\npassword=${PASSWORD}\n`);
  });

  test("answers 204 for an ignored store", async () => {
    const response = await post("/credentials/git/store", GET_BODY);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  test("rejects a missing token with 401", async () => {
    const response = await post("/credentials/git/get", GET_BODY, null);
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(PASSWORD);
  });

  test("rejects a wrong token with 401", async () => {
    for (const authorization of [
      "Bearer wrong",
      `Bearer ${TOKEN}x`,
      `Basic ${TOKEN}`,
    ]) {
      const response = await post(
        "/credentials/git/get",
        GET_BODY,
        authorization,
      );
      expect(response.status).toBe(401);
    }
  });

  test("checks the token before routing", async () => {
    const response = await post("/nope", GET_BODY, null);
    expect(response.status).toBe(401);
  });

  test("answers 404 for other paths, kinds and methods", async () => {
    expect((await post("/credentials/docker/get", GET_BODY)).status).toBe(404);
    expect((await post("/credentials/git", GET_BODY)).status).toBe(404);
    expect((await post("/", GET_BODY)).status).toBe(404);
    const response = await fetch(`${baseUrl}/credentials/git/get`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(404);
  });

  test("answers 413 for a body over 16 KB", async () => {
    const body = "x".repeat(MAX_CREDENTIAL_REQUEST_BYTES + 1);
    const response = await post("/credentials/git/get", body);
    expect(response.status).toBe(413);
  });

  test("answers 400 for an unknown operation or a malformed get", async () => {
    expect((await post("/credentials/git/approve", GET_BODY)).status).toBe(400);
    expect(
      (await post("/credentials/git/get", "host=github.com\n")).status,
    ).toBe(400);
  });

  test("stop is idempotent", async () => {
    await server.stop();
    await server.stop();
  });
});

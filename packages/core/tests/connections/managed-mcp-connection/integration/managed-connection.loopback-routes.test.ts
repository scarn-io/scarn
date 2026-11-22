import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { removeUndecryptableSigningKeys } from "@scarn/identity/testing/access-jwt-signing-keys";
import type { UuidV7 } from "@/common/contracts/uuid-v7";
import {
  createProjectSecretsTestProject,
  createProjectSecretsTestUser,
  type ProjectSecretsTestUser,
} from "tests/secrets/secret/integration/project-secret-test-support";
import { unwrapAsync } from "tests/utils";
import { createManagedConnectionHarness } from "./managed-connection-test-support";

const LOOPBACK_REDIRECT = "http://127.0.0.1:53682/callback";
const SOME_UUID = "01900000-0000-7000-8000-000000000000" as UuidV7;

/**
 * The CLI's loopback sign-in over HTTP (decisions 3, 4 and 8): start,
 * follow the fake's `/authorize` to the loopback redirect, complete with the
 * completion secret, then confirm or cancel, all with the CLI's access token
 * and no `Origin`.
 */
describe("managed connection loopback routes", () => {
  const harness = createManagedConnectionHarness();
  const { fake, clock, app, apiClient, connections } = harness;

  afterEach(() => {
    fake.reset();
    clock.reset();
  });

  afterAll(async () => {
    await fake.stop();
  });

  /** The CLI's credential: an access JWT minted from the user's session. */
  const accessHeadersOf = async (user: ProjectSecretsTestUser) => {
    await removeUndecryptableSigningKeys();
    const response = await app.handle(
      new Request("http://localhost/api/auth/token", {
        headers: user.authHeaders,
      }),
    );
    expect(response.status).toBe(200);
    const { token } = (await response.json()) as { token: string };
    return { authorization: `Bearer ${token}` };
  };

  const setUp = async (label: string) => {
    const owner = await createProjectSecretsTestUser(label);
    const projectId = await createProjectSecretsTestProject(apiClient, owner);
    await harness.seedFakeConnection(projectId);
    return { owner, projectId, headers: await accessHeadersOf(owner) };
  };

  const startLoopback = async (
    projectId: UuidV7,
    headers: Record<string, string>,
  ) => {
    const response = await connections(projectId).loopback.post(
      { preset: "notion", redirectUri: LOOPBACK_REDIRECT },
      { headers },
    );
    expect(response.status).toBe(201);
    expect(response.response.headers.get("cache-control")).toBe("no-store");
    return await unwrapAsync(Promise.resolve(response));
  };

  const redirectedTo = async (authorizationUrl: string) => {
    const location = await harness.authorize(authorizationUrl);
    expect(`${location.origin}${location.pathname}`).toBe(LOOPBACK_REDIRECT);
    return {
      state: location.searchParams.get("state") ?? "",
      code: location.searchParams.get("code") ?? "",
      iss: location.searchParams.get("iss") ?? "",
    };
  };

  const complete = (
    attemptId: UuidV7,
    body: {
      completionSecret: string;
      state: string;
      code?: string;
      iss?: string;
      error?: string;
    },
    headers: Record<string, string>,
  ) =>
    apiClient.api["mcp-connection-attempts"]({ attemptId }).complete.post(
      body,
      { headers },
    );

  test("start → authorize → complete → confirm over HTTP with an access token", async () => {
    const { projectId, headers } = await setUp("lbr-loop");

    const started = await startLoopback(projectId, headers);
    expect(started.completionSecret).toMatch(/^[\w-]{43}$/u);
    expect(
      new URL(started.authorizationUrl).searchParams.get("redirect_uri"),
    ).toBe(LOOPBACK_REDIRECT);

    const redirect = await redirectedTo(started.authorizationUrl);
    const completed = await complete(
      started.attemptId,
      { completionSecret: started.completionSecret, ...redirect },
      headers,
    );
    expect(completed.response.headers.get("cache-control")).toBe("no-store");
    const pending = await unwrapAsync(Promise.resolve(completed));
    expect(pending).toMatchObject({
      id: started.connectionId,
      projectId,
      state: "awaiting_confirmation",
    });
    const candidate = pending.candidate;
    if (!candidate) {
      throw new Error("expected a candidate");
    }
    expect(fake.callsTo("token")[0]?.params["redirect_uri"]).toBe(
      LOOPBACK_REDIRECT,
    );

    const ready = await unwrapAsync(
      connections(projectId)({
        connectionId: started.connectionId,
      }).candidate.confirm.cli.post(
        {
          candidateId: candidate.id,
          fingerprint: candidate.fingerprint,
          expectedVersion: pending.version,
        },
        { headers },
      ),
    );
    expect(ready).toMatchObject({ state: "ready", candidate: null });
  });

  test("a reconnect started from the CLI can be cancelled from the CLI", async () => {
    const { owner, projectId, connectionId } =
      await harness.connectToReady("lbr-reconnect");
    const headers = await accessHeadersOf(owner);
    fake.reset();

    const response = await connections(projectId)({
      connectionId,
    }).reconnect.loopback.post({ redirectUri: LOOPBACK_REDIRECT }, { headers });
    expect(response.status).toBe(201);
    expect(response.response.headers.get("cache-control")).toBe("no-store");
    const started = await unwrapAsync(Promise.resolve(response));
    const redirect = await redirectedTo(started.authorizationUrl);
    const pending = await unwrapAsync(
      complete(
        started.attemptId,
        { completionSecret: started.completionSecret, ...redirect },
        headers,
      ),
    );
    const candidate = pending.candidate;
    if (!candidate) {
      throw new Error("expected a reconnect candidate");
    }

    const cancelled = await unwrapAsync(
      connections(projectId)({ connectionId }).candidate.cancel.cli.post(
        { candidateId: candidate.id },
        { headers },
      ),
    );
    expect(cancelled).toMatchObject({ state: "ready", candidate: null });
  });

  test("a wrong completion secret is a 409 that names nothing", async () => {
    const { projectId, headers } = await setUp("lbr-wrong-secret");
    const started = await startLoopback(projectId, headers);
    const redirect = await redirectedTo(started.authorizationUrl);

    const response = await complete(
      started.attemptId,
      { completionSecret: `${started.completionSecret}x`, ...redirect },
      headers,
    );

    expect(response.status).toBe(409);
    expect(response.error?.value).toMatchObject({
      code: "MANAGED_CONNECTION_COMPLETION_FAILED",
      meta: { reason: "invalid_callback" },
    });
    expect(JSON.stringify(response.error?.value)).not.toContain(projectId);
    expect(fake.callsTo("token")).toHaveLength(0);
  });

  test("a denial is a 409 with reason access_denied", async () => {
    const { projectId, headers } = await setUp("lbr-denied");
    const started = await startLoopback(projectId, headers);
    const redirect = await redirectedTo(started.authorizationUrl);

    const response = await complete(
      started.attemptId,
      {
        completionSecret: started.completionSecret,
        state: redirect.state,
        iss: redirect.iss,
        error: "access_denied",
      },
      headers,
    );

    expect(response.status).toBe(409);
    expect(response.error?.value).toMatchObject({
      code: "MANAGED_CONNECTION_COMPLETION_FAILED",
      meta: { reason: "access_denied" },
    });
  });

  test("a redirect URI that isn't loopback is 422", async () => {
    const { projectId, headers } = await setUp("lbr-bad-redirect");

    const response = await connections(projectId).loopback.post(
      { preset: "notion", redirectUri: "https://evil.example/callback" },
      { headers },
    );

    expect(response.status).toBe(422);
    expect(response.error?.value).toMatchObject({
      code: "MANAGED_CONNECTION_REDIRECT_INVALID",
    });
    expect(fake.calls).toHaveLength(0);
  });

  test("a reconnect redirect URI that isn't loopback is 422", async () => {
    const { owner, projectId, connectionId } = await harness.connectToReady(
      "lbr-bad-reconnect-redirect",
    );
    fake.reset();

    const response = await connections(projectId)({
      connectionId,
    }).reconnect.loopback.post(
      { redirectUri: "http://example.com:53682/callback" },
      { headers: await accessHeadersOf(owner) },
    );

    expect(response.status).toBe(422);
    expect(response.error?.value).toMatchObject({
      code: "MANAGED_CONNECTION_REDIRECT_INVALID",
    });
  });

  test("every route is 401 without auth", async () => {
    const projectId = SOME_UUID;
    const connection = connections(projectId)({ connectionId: SOME_UUID });
    const candidate = {
      candidateId: SOME_UUID,
      fingerprint: "f",
      expectedVersion: 0,
    };
    const responses = await Promise.all([
      connections(projectId).loopback.post({
        preset: "notion",
        redirectUri: LOOPBACK_REDIRECT,
      }),
      connection.reconnect.loopback.post({ redirectUri: LOOPBACK_REDIRECT }),
      complete(SOME_UUID, { completionSecret: "s", state: "s", code: "c" }, {}),
      connection.candidate.confirm.cli.post(candidate),
      connection.candidate.cancel.cli.post({ candidateId: SOME_UUID }),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([
      401, 401, 401, 401, 401,
    ]);
  });
});

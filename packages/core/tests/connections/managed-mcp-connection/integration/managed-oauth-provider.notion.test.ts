import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createApp } from "@scarn/api/app";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { ManagedOAuthAttemptEntity } from "@/connections/managed-mcp-connection/domain/managed-oauth-attempt-entity";
import { cimdClientIdentity } from "@/connections/managed-mcp-connection/infra/cimd-client-registry";
import { GuardedFetch } from "@/connections/managed-mcp-connection/infra/guarded-fetch";
import { MANAGED_CONNECTION_PRESETS } from "@/connections/managed-mcp-connection/infra/managed-connection-presets";
import { McpOAuthProvider } from "@/connections/managed-mcp-connection/infra/mcp-oauth-provider";
import { createAppContext } from "@/lib/di";
import { systemTimeProvider } from "@/lib/time-provider";
import { FakeMcpOAuth } from "tests/connections/support/fake-mcp-oauth";
import { createScarnTreaty } from "tests/treaty";

const APP_URL = "https://scarn.test";
const CLIENT_ID = `${APP_URL}/api/oauth/mcp/client-metadata.json`;
const REDIRECT_URI = `${APP_URL}/api/oauth/mcp/callback`;

/**
 * The Notion adapter end to end against a loopback fake of Notion's OAuth
 * server. The fake fetches Scarn's CIMD document from the in-process API, as
 * Notion would from the deployed one.
 */
describe("Notion managed OAuth provider", () => {
  const appRef: { current: ReturnType<typeof createApp> | null } = {
    current: null,
  };
  const fake = new FakeMcpOAuth({
    fetchClientMetadata: (url) =>
      appRef.current?.handle(new Request(url)) ??
      Promise.resolve(new Response(null, { status: 503 })),
    slowMs: 500,
  }).start();
  const appContext = createAppContext({
    appUrl: APP_URL,
    apiUrl: null,
    managedOAuthLoopbackOrigins: [fake.origin],
  });
  const app = createApp(appContext);
  appRef.current = app;
  const provider = appContext.managedOAuthProviders.for({
    server: { ...fake.target, clientRegistration: "cimd" },
    preset: "notion",
  });

  const newAttempt = () =>
    ManagedOAuthAttemptEntity.create({
      id: createUuidV7(),
      connectionId: createUuidV7(),
      projectId: createUuidV7(),
      kind: "connect",
      expectedGeneration: 0,
      actorUserId: createUuidV7(),
      binding: { kind: "browser", sessionDigest: "session-digest" },
      stateDigest: "state-digest",
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      requestedScopes: [],
      encryptedPkceVerifier: {
        ciphertext: Buffer.from("c"),
        iv: Buffer.from("i"),
        authTag: Buffer.from("t"),
        keyVersion: 1,
      },
      now: new Date(),
    });

  const authorize = async () => {
    const attempt = newAttempt();
    const pkceVerifier = crypto.randomUUID() + crypto.randomUUID();
    const response = await fetch(
      await provider.authorizationUrl({
        attempt,
        state: "state-1",
        pkceVerifier,
      }),
      { redirect: "manual" },
    );
    const location = response.headers.get("location");
    return {
      attempt,
      pkceVerifier,
      status: response.status,
      callback: location ? new URL(location) : null,
    };
  };

  afterEach(() => {
    fake.reset();
  });
  afterAll(async () => {
    await fake.stop();
  });

  test("serves a CIMD document matching the configured client exactly", async () => {
    const { data, status } =
      await createScarnTreaty(app).api.oauth.mcp["client-metadata.json"].get();

    expect(status).toBe(200);
    expect(data).toEqual({
      client_id: CLIENT_ID,
      client_name: "Scarn",
      redirect_uris: [REDIRECT_URI, "http://127.0.0.1/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(cimdClientIdentity(`${APP_URL}/api`)).toEqual({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
    });
  });

  test("authorizes and exchanges a code for a refreshable grant", async () => {
    const { attempt, pkceVerifier, status, callback } = await authorize();

    expect(status).toBe(302);
    expect(`${callback?.origin ?? ""}${callback?.pathname ?? ""}`).toBe(
      REDIRECT_URI,
    );
    expect(callback?.searchParams.get("state")).toBe("state-1");
    expect(callback?.searchParams.get("iss")).toBe(fake.origin);

    const result = await provider.exchangeCode({
      attempt,
      code: callback?.searchParams.get("code") ?? "",
      pkceVerifier,
    });

    expect(result).toMatchObject({
      status: "succeeded",
      issuer: fake.origin,
      resource: fake.resource,
      identity: {
        userId: fake.identity.userId,
        userName: fake.identity.userName,
        workspaceId: fake.identity.workspaceId,
        workspaceName: fake.identity.workspaceName,
      },
      grantedScopes: ["default"],
    });
    const tokenCall = fake.callsTo("token")[0];
    expect(tokenCall?.params).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      resource: fake.resource,
      code_verifier: pkceVerifier,
    });
  });

  test("rejects a client whose CIMD redirect URI doesn't match", async () => {
    const attempt = ManagedOAuthAttemptEntity.rehydrate({
      ...newAttempt().toJSON(),
      redirectUri: `${APP_URL}/api/oauth/mcp/callback/`,
    });
    const response = await fetch(
      await provider.authorizationUrl({
        attempt,
        state: "state-1",
        pkceVerifier: "v".repeat(43),
      }),
      { redirect: "manual" },
    );

    expect(response.status).toBe(400);
  });

  test("fails an exchange without a refresh token with missing_refresh", async () => {
    fake.faults = { token: "no_refresh_token" };
    const { attempt, pkceVerifier, callback } = await authorize();

    expect(
      await provider.exchangeCode({
        attempt,
        code: callback?.searchParams.get("code") ?? "",
        pkceVerifier,
      }),
    ).toEqual({ status: "failed", failureCode: "missing_refresh" });
  });

  test("maps invalid_client to client_configuration", async () => {
    fake.faults = { token: "invalid_client" };
    const { attempt, pkceVerifier, callback } = await authorize();

    expect(
      await provider.exchangeCode({
        attempt,
        code: callback?.searchParams.get("code") ?? "",
        pkceVerifier,
      }),
    ).toEqual({ status: "failed", failureCode: "client_configuration" });
  });

  test("treats a 5xx token response as an unknown outcome without retrying", async () => {
    fake.faults = { token: "server_error" };
    const { attempt, pkceVerifier, callback } = await authorize();

    expect(
      await provider.exchangeCode({
        attempt,
        code: callback?.searchParams.get("code") ?? "",
        pkceVerifier,
      }),
    ).toEqual({ status: "failed", failureCode: "exchange_unknown" });
    expect(fake.callsTo("token")).toHaveLength(1);
  });

  test("the fake can omit or forge the callback iss", async () => {
    fake.faults = { authorize: "missing_iss" };
    expect((await authorize()).callback?.searchParams.has("iss")).toBe(false);

    fake.faults = { authorize: "wrong_iss" };
    expect((await authorize()).callback?.searchParams.get("iss")).not.toBe(
      fake.origin,
    );
  });

  const shortTimeoutProvider = (server = fake) =>
    new McpOAuthProvider({
      guardedFetch: new GuardedFetch({
        allowedOrigins: ["https://mcp.notion.com"],
        loopbackOrigins: [server.origin],
        timeoutMs: 100,
      }),
      timeProvider: systemTimeProvider,
      server: { ...server.target, clientRegistration: "cimd" },
      preset: MANAGED_CONNECTION_PRESETS.notion,
    });

  describe("refresh", () => {
    const credentialsFor = (refreshToken: string) => ({
      accessToken: "old-access",
      tokenType: "bearer" as const,
      accessExpiresAt: new Date(0),
      refreshToken,
    });

    const refresh = (refreshToken: string, target = provider) =>
      target.refresh({
        grant: { clientId: CLIENT_ID } as never,
        credentials: credentialsFor(refreshToken),
      });

    test("rotates the refresh token and returns a new access token", async () => {
      const refreshToken = fake.issueRefreshToken(CLIENT_ID);
      const before = Date.now();

      const result = await refresh(refreshToken);

      if (result.status !== "refreshed") {
        throw new Error(`expected refreshed, got ${result.status}`);
      }
      expect(result.credentials.accessToken).not.toBe("old-access");
      expect(result.credentials.refreshToken).not.toBe(refreshToken);
      expect(fake.issuedTokens).toContain(result.credentials.refreshToken);
      expect(result.credentials.tokenType).toBe("bearer");
      expect(
        result.credentials.accessExpiresAt.getTime(),
      ).toBeGreaterThanOrEqual(before + 3600 * 1000);
      expect(fake.callsTo("refresh")[0]?.params).toEqual({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
        resource: fake.resource,
      });
      expect(fake.refreshCount).toBe(1);
      expect(fake.callsTo("token")).toHaveLength(0);
    });

    test("chains rotations: each new refresh token works once", async () => {
      const first = fake.issueRefreshToken(CLIENT_ID);
      const second = await refresh(first);
      if (second.status !== "refreshed") {
        throw new Error(`expected refreshed, got ${second.status}`);
      }

      expect((await refresh(second.credentials.refreshToken)).status).toBe(
        "refreshed",
      );
      expect(fake.refreshCount).toBe(2);
    });

    test("keeps the old refresh token when the response has none", async () => {
      fake.faults = { refresh: "no_refresh_token" };
      const refreshToken = fake.issueRefreshToken(CLIENT_ID);

      const result = await refresh(refreshToken);

      expect(result).toMatchObject({
        status: "refreshed",
        credentials: { refreshToken },
      });
    });

    test("maps invalid_grant to rejected", async () => {
      fake.faults = { refresh: "invalid_grant" };
      expect(await refresh(fake.issueRefreshToken(CLIENT_ID))).toEqual({
        status: "rejected",
      });
    });

    test("maps invalid_client to client_rejected", async () => {
      fake.faults = { refresh: "invalid_client" };
      expect(await refresh(fake.issueRefreshToken(CLIENT_ID))).toEqual({
        status: "client_rejected",
      });
    });

    test("rejects a replayed refresh token", async () => {
      const refreshToken = fake.issueRefreshToken(CLIENT_ID);
      expect((await refresh(refreshToken)).status).toBe("refreshed");

      expect(await refresh(refreshToken)).toEqual({ status: "rejected" });
      expect(fake.refreshCount).toBe(2);
    });

    test("reports a 5xx as server_error without retrying", async () => {
      fake.faults = { refresh: "server_error" };
      expect(await refresh(fake.issueRefreshToken(CLIENT_ID))).toEqual({
        status: "server_error",
      });
      expect(fake.refreshCount).toBe(1);
    });

    test("reports a timeout as unknown", async () => {
      fake.faults = { refresh: "slow" };
      expect(
        await refresh(
          fake.issueRefreshToken(CLIENT_ID),
          shortTimeoutProvider(),
        ),
      ).toEqual({ status: "unknown" });
      expect(fake.refreshCount).toBe(1);
    });

    test("reports a response dropped after rotation as unknown, and the old token is spent", async () => {
      fake.faults = { refresh: "drop_response_after_rotate" };
      const refreshToken = fake.issueRefreshToken(CLIENT_ID);
      expect(await refresh(refreshToken, shortTimeoutProvider())).toEqual({
        status: "unknown",
      });

      fake.faults = {};
      expect(await refresh(refreshToken)).toEqual({ status: "rejected" });
    });

    test("reports a 2xx without a usable expires_in as unknown", async () => {
      fake.faults = { refresh: "no_expires_in" };
      expect(await refresh(fake.issueRefreshToken(CLIENT_ID))).toEqual({
        status: "unknown",
      });
    });

    test("reports a refused connection as not_attempted", async () => {
      const gone = new FakeMcpOAuth().start();
      const target = shortTimeoutProvider(gone);
      await target.discover();
      await gone.stop();

      expect(await refresh("any", target)).toEqual({
        status: "not_attempted",
      });
    });

    test("reports a blocked destination as not_attempted", async () => {
      const blocked = new McpOAuthProvider({
        guardedFetch: new GuardedFetch({
          allowedOrigins: ["https://mcp.notion.com"],
        }),
        timeProvider: systemTimeProvider,
        server: { ...fake.target, clientRegistration: "cimd" },
        preset: MANAGED_CONNECTION_PRESETS.notion,
      });

      expect(await refresh("any", blocked)).toEqual({
        status: "not_attempted",
      });
      expect(fake.refreshCount).toBe(0);
    });
  });

  describe("revoke", () => {
    const revoke = (target = provider) =>
      target.revoke({
        grant: { clientId: CLIENT_ID } as never,
        credentials: {
          accessToken: "access",
          tokenType: "bearer",
          accessExpiresAt: new Date(),
          refreshToken: "refresh",
        },
      });

    test("posts the refresh token to the advertised revocation endpoint", async () => {
      expect(await revoke()).toBe("accepted");
      expect(fake.callsTo("revoke")[0]?.params).toEqual({
        token: "refresh",
        token_type_hint: "refresh_token",
        client_id: CLIENT_ID,
      });
    });

    test("reports a revocation that times out as unconfirmed", async () => {
      fake.faults = { revoke: "slow" };
      expect(await revoke(shortTimeoutProvider())).toBe("unconfirmed");
    });

    test("reports a 5xx revocation as failed", async () => {
      fake.faults = { revoke: "server_error" };
      expect(await revoke()).toBe("failed");
    });
  });
});

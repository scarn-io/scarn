import { describe, expect } from "bun:test";
import { cimdClientIdentity } from "@/connections/managed-mcp-connection/infra/cimd-client-registry";
import { ManagedOAuthDiscoveryError } from "@/connections/managed-mcp-connection/infra/mcp-oauth-metadata";
import { concurrentTest } from "tests/utils";
import {
  CLIENT_IDENTITY,
  NOW,
  NOTION_MCP_ORIGIN,
  NOTION_MCP_RESOURCE,
  tokenResponse,
  json,
  providerWith,
  attempt,
  exchange,
  type Stub,
} from "./mcp-oauth-provider-fixtures";

describe("McpOAuthProvider with the Notion preset: discover", () => {
  concurrentTest("accepts Notion's metadata", async () => {
    const { provider } = providerWith();
    expect(await provider.discover()).toEqual({
      issuer: NOTION_MCP_ORIGIN,
      resource: NOTION_MCP_RESOURCE,
      authorizationEndpoint: `${NOTION_MCP_ORIGIN}/authorize`,
      tokenEndpoint: `${NOTION_MCP_ORIGIN}/token`,
      revocationEndpoint: `${NOTION_MCP_ORIGIN}/token`,
      registrationEndpoint: null,
      issParameterSupported: true,
      scopesSupported: ["default"],
    });
  });

  const mismatches: [string, Stub][] = [
    [
      "resource",
      { protectedResource: { resource: "https://mcp.notion.com/sse" } },
    ],
    [
      "authorization_servers",
      {
        protectedResource: { authorization_servers: ["https://evil.example"] },
      },
    ],
    ["issuer", { authorizationServer: { issuer: "https://evil.example" } }],
    [
      "S256",
      { authorizationServer: { code_challenge_methods_supported: ["plain"] } },
    ],
    [
      "authorization_code",
      { authorizationServer: { grant_types_supported: ["refresh_token"] } },
    ],
    [
      "refresh_token",
      {
        authorizationServer: { grant_types_supported: ["authorization_code"] },
      },
    ],
    [
      "iss parameter",
      {
        authorizationServer: {
          authorization_response_iss_parameter_supported: false,
        },
      },
    ],
    [
      "CIMD",
      {
        authorizationServer: {
          client_id_metadata_document_supported: undefined,
        },
      },
    ],
    [
      "none auth method",
      {
        authorizationServer: {
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
        },
      },
    ],
    [
      "token endpoint origin",
      { authorizationServer: { token_endpoint: "https://evil.example/token" } },
    ],
    [
      "revocation endpoint origin",
      {
        authorizationServer: {
          revocation_endpoint: "http://mcp.notion.com/token",
        },
      },
    ],
  ];

  for (const [field, stub] of mismatches) {
    concurrentTest(`rejects a mismatched ${field}`, async () => {
      const { provider } = providerWith(stub);
      let error: Error | null = null;
      try {
        await provider.discover();
      } catch (caught) {
        error = caught as Error;
      }
      expect(error).toBeInstanceOf(ManagedOAuthDiscoveryError);
    });
  }

  concurrentTest("caches metadata for five minutes", async () => {
    let now = NOW;
    const { provider, requests } = providerWith({}, undefined, () => now);

    await provider.discover();
    await provider.discover();
    expect(requests).toHaveLength(2);
    now = new Date(NOW.getTime() + 5 * 60 * 1000);
    await provider.discover();
    expect(requests).toHaveLength(4);
  });
});

describe("cimdClientIdentity", () => {
  concurrentTest(
    "derives client_id and redirect URI from the API base URL",
    () => {
      expect(cimdClientIdentity("https://app.scarn.test/api/")).toEqual({
        clientId: "https://app.scarn.test/api/oauth/mcp/client-metadata.json",
        redirectUri: "https://app.scarn.test/api/oauth/mcp/callback",
      });
    },
  );
});

describe("McpOAuthProvider with the Notion preset: authorizationUrl", () => {
  concurrentTest("builds an S256 PKCE request for the resource", async () => {
    const { provider } = providerWith();
    const url = new URL(
      await provider.authorizationUrl({
        attempt: attempt(),
        state: "state-1",
        pkceVerifier: "verifier-1",
      }),
    );

    expect(url.origin + url.pathname).toBe(`${NOTION_MCP_ORIGIN}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "https://app.scarn.test/api/oauth/mcp/client-metadata.json",
      redirect_uri: "https://app.scarn.test/api/oauth/mcp/callback",
      state: "state-1",
      code_challenge: new Bun.CryptoHasher("sha256")
        .update("verifier-1")
        .digest("base64url"),
      code_challenge_method: "S256",
      resource: NOTION_MCP_RESOURCE,
    });
  });
});

describe("McpOAuthProvider with the Notion preset: exchangeCode", () => {
  const scopeCases: [string | undefined, string[], string[]][] = [
    [undefined, [], []],
    [undefined, ["default"], ["default"]],
    ["", ["default"], []],
    ["read", ["read", "write"], ["read"]],
    ["read,write", ["read"], ["read", "write"]],
    [
      " read ,write  files:read\tchat",
      [],
      ["read", "write", "files:read", "chat"],
    ],
  ];
  for (const [scope, requestedScopes, grantedScopes] of scopeCases) {
    concurrentTest(
      `resolves scope ${String(scope)} for request ${requestedScopes.join(" ")}`,
      async () => {
        const { result } = exchange(
          {
            token: () => Promise.resolve(json({ ...tokenResponse, scope })),
          },
          requestedScopes,
        );
        expect(await result).toMatchObject({
          status: "succeeded",
          grantedScopes,
        });
      },
    );
  }

  concurrentTest(
    "sends client_id, resource, verifier and redirect URI; ignores unknown fields",
    async () => {
      const { result, requests } = exchange({});
      expect(await result).toEqual({
        status: "succeeded",
        issuer: NOTION_MCP_ORIGIN,
        resource: NOTION_MCP_RESOURCE,
        credentials: {
          accessToken: "access-1",
          tokenType: "bearer",
          accessExpiresAt: new Date(NOW.getTime() + 3600 * 1000),
          refreshToken: "refresh-1",
        },
        identity: {
          userId: "user-1",
          userName: "User",
          workspaceId: "ws-1",
          workspaceName: "Workspace",
        },
        grantedScopes: ["default"],
        authorizedAt: NOW,
      });
      const tokenCall = requests.find((request) =>
        request.url.endsWith("/token"),
      );
      expect(Object.fromEntries(new URLSearchParams(tokenCall?.body))).toEqual({
        grant_type: "authorization_code",
        code: "code-1",
        redirect_uri: "https://app.scarn.test/api/oauth/mcp/callback",
        client_id: "https://app.scarn.test/api/oauth/mcp/client-metadata.json",
        code_verifier: "verifier-1",
        resource: NOTION_MCP_RESOURCE,
      });
    },
  );

  const failures: [string, Record<string, unknown>, string][] = [
    ["no refresh token", { refresh_token: undefined }, "missing_refresh"],
    ["an empty refresh token", { refresh_token: "" }, "missing_refresh"],
    ["no expiry", { expires_in: undefined }, "missing_expiry"],
    ["a zero expiry", { expires_in: 0 }, "missing_expiry"],
    ["a string expiry", { expires_in: "3600" }, "missing_expiry"],
    ["an empty access token", { access_token: "" }, "exchange_failed"],
    ["a non-bearer token", { token_type: "mac" }, "exchange_failed"],
    ["malformed scopes", { scope: ["default"] }, "exchange_failed"],
    [
      "no identity",
      { workspace_id: undefined, owner: undefined },
      "missing_identity",
    ],
  ];

  for (const [name, overrides, failureCode] of failures) {
    concurrentTest(`fails a response with ${name}`, async () => {
      const { result } = exchange({
        token: () => Promise.resolve(json({ ...tokenResponse, ...overrides })),
      });
      expect(await result).toEqual({ status: "failed", failureCode } as never);
    });
  }

  concurrentTest("treats a 5xx as an unknown outcome", async () => {
    const { result } = exchange({
      token: () => Promise.resolve(json({ error: "server_error" }, 502)),
    });
    expect(await result).toEqual({
      status: "failed",
      failureCode: "exchange_unknown",
    });
  });
});

describe("McpOAuthProvider with the Notion preset: revoke", () => {
  const revokeWith = async (stub: Stub, timeoutMs?: number) => {
    const { provider, requests } = providerWith(stub, timeoutMs);
    const outcome = await provider.revoke({
      grant: { clientId: CLIENT_IDENTITY.clientId } as never,
      credentials: {
        accessToken: "access-1",
        tokenType: "bearer",
        accessExpiresAt: NOW,
        refreshToken: "refresh-1",
      },
    });
    return { outcome, requests };
  };

  concurrentTest("posts the refresh token as a public client", async () => {
    const { outcome, requests } = await revokeWith({});
    expect(outcome).toBe("accepted");
    const revokeCall = requests.find((request) =>
      request.url.endsWith("/token"),
    );
    expect(Object.fromEntries(new URLSearchParams(revokeCall?.body))).toEqual({
      token: "refresh-1",
      token_type_hint: "refresh_token",
      client_id: "https://app.scarn.test/api/oauth/mcp/client-metadata.json",
    });
  });

  concurrentTest("reports a rejected revocation as failed", async () => {
    const { outcome } = await revokeWith({
      token: () => Promise.resolve(json({ error: "invalid_request" }, 400)),
    });
    expect(outcome).toBe("failed");
  });

  concurrentTest("reports a timed-out revocation as unconfirmed", async () => {
    const { outcome } = await revokeWith(
      {
        token: () =>
          new Promise((resolve) => {
            globalThis.setTimeout(() => {
              resolve(json({}));
            }, 500);
          }),
      },
      50,
    );
    expect(outcome).toBe("unconfirmed");
  });
});

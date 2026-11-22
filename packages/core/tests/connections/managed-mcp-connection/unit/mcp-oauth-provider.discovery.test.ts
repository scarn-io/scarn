import { describe, expect } from "bun:test";
import type { ManagedConnectionDiscovery } from "@/connections/managed-mcp-connection/domain/managed-connection-discovery";
import { ManagedOAuthDiscoveryError } from "@/connections/managed-mcp-connection/infra/mcp-oauth-metadata";
import { concurrentTest } from "tests/utils";
import {
  NOW,
  exchange,
  json,
  providerWith,
  tokenResponse,
  type Stub,
  type Target,
} from "./mcp-oauth-provider-fixtures";

const MCP_ORIGIN = "https://mcp.slack.test";
const RESOURCE = `${MCP_ORIGIN}/mcp`;
const ENDPOINT_ORIGIN = "https://slack.test";
const ROOT_METADATA = `${MCP_ORIGIN}/.well-known/oauth-protected-resource`;

const OVERRIDES: ManagedConnectionDiscovery = {
  resourceMetadataUrl: ROOT_METADATA,
  advertisedResource: MCP_ORIGIN,
  endpointOrigins: [ENDPOINT_ORIGIN],
  tokenErrors: "slack",
};

const slackTarget = (
  discovery: ManagedConnectionDiscovery = OVERRIDES,
  clientRegistration: "supplied" | "dcr" = "supplied",
): Target => ({
  server:
    clientRegistration === "supplied"
      ? {
          resource: RESOURCE,
          issuerOrigin: MCP_ORIGIN,
          discovery,
          clientRegistration,
          suppliedClientId: "slack-client",
          suppliedRedirectUri: "http://localhost:3118/callback",
        }
      : {
          resource: RESOURCE,
          issuerOrigin: MCP_ORIGIN,
          discovery,
          clientRegistration,
        },
  preset: null,
  protectedResource: {
    resource: MCP_ORIGIN,
    authorization_servers: [MCP_ORIGIN],
  },
  authorizationServer: {
    issuer: MCP_ORIGIN,
    authorization_endpoint: `${ENDPOINT_ORIGIN}/oauth/v2_user/authorize`,
    token_endpoint: `${ENDPOINT_ORIGIN}/api/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
  },
  allowedOrigins: [MCP_ORIGIN, ENDPOINT_ORIGIN],
});

const discoveryError = async (
  stub: Stub,
  target: Target = slackTarget(),
): Promise<unknown> => {
  try {
    await providerWith(stub, undefined, undefined, target).provider.discover();
    return null;
  } catch (caught) {
    return caught;
  }
};

describe("McpOAuthProvider discovery with overrides", () => {
  concurrentTest(
    "reads the override metadata URL and takes the advertised resource as the audience",
    async () => {
      const { provider, requests } = providerWith(
        {},
        undefined,
        undefined,
        slackTarget(),
      );
      expect(await provider.discover()).toMatchObject({
        issuer: MCP_ORIGIN,
        resource: MCP_ORIGIN,
        authorizationEndpoint: `${ENDPOINT_ORIGIN}/oauth/v2_user/authorize`,
        tokenEndpoint: `${ENDPOINT_ORIGIN}/api/token`,
      });
      expect(requests.map((request) => request.url)).toEqual([
        ROOT_METADATA,
        `${MCP_ORIGIN}/.well-known/oauth-authorization-server`,
      ]);
    },
  );

  const rejected: [string, Stub, Target?][] = [
    [
      "a revocation endpoint on an endpoint origin",
      {
        authorizationServer: {
          revocation_endpoint: `${ENDPOINT_ORIGIN}/revoke`,
        },
      },
    ],
    [
      "a registration endpoint on an endpoint origin",
      {
        authorizationServer: {
          registration_endpoint: `${ENDPOINT_ORIGIN}/register`,
        },
      },
    ],
    [
      "a token endpoint on an origin no override lists",
      {
        authorizationServer: { token_endpoint: "https://other.test/token" },
      },
    ],
    [
      "a resource other than the advertised one",
      { protectedResource: { resource: RESOURCE } },
    ],
    [
      "a resource metadata URL off the MCP origin",
      {},
      slackTarget({
        ...OVERRIDES,
        resourceMetadataUrl: `${ENDPOINT_ORIGIN}/.well-known/oauth-protected-resource`,
      }),
    ],
    [
      "an advertised resource off the MCP origin",
      {},
      slackTarget({ ...OVERRIDES, advertisedResource: ENDPOINT_ORIGIN }),
    ],
    [
      "client_secret_post only for a client Scarn registers",
      {
        authorizationServer: {
          registration_endpoint: `${MCP_ORIGIN}/register`,
        },
      },
      slackTarget(OVERRIDES, "dcr"),
    ],
    [
      "no S256, overrides or not",
      { authorizationServer: { code_challenge_methods_supported: ["plain"] } },
    ],
  ];

  for (const [name, stub, target] of rejected) {
    concurrentTest(`rejects ${name}`, async () => {
      expect(await discoveryError(stub, target)).toBeInstanceOf(
        ManagedOAuthDiscoveryError,
      );
    });
  }

  concurrentTest(
    "accepts client_secret_post only for a supplied client",
    async () => {
      expect(await discoveryError({})).toBeNull();
    },
  );
});

describe("McpOAuthProvider with Slack token errors", () => {
  const refreshWith = async (
    response: Response,
    discovery: ManagedConnectionDiscovery = OVERRIDES,
  ) =>
    await providerWith(
      { token: () => Promise.resolve(response) },
      undefined,
      undefined,
      slackTarget(discovery),
    ).provider.refresh({
      grant: { clientId: "slack-client" } as never,
      credentials: {
        accessToken: "access-0",
        tokenType: "bearer",
        accessExpiresAt: NOW,
        refreshToken: "refresh-0",
      },
    });

  concurrentTest.each([
    ["invalid_refresh_token", "rejected"],
    ["token_revoked", "rejected"],
    ["invalid_client_id", "client_rejected"],
    ["bad_client_secret", "client_rejected"],
    ["internal_error", "unknown"],
  ] as const)(
    "reads a refresh answered 200 ok:false %s as %s",
    async (error, status) => {
      expect(await refreshWith(json({ ok: false, error }))).toEqual({
        status,
      });
    },
  );

  concurrentTest(
    "refreshes on 200 ok:true with a comma-separated scope",
    async () => {
      expect(
        await refreshWith(json({ ok: true, ...tokenResponse, scope: "a,b" })),
      ).toMatchObject({ status: "refreshed" });
    },
  );

  concurrentTest(
    "reads 200 ok:false as unknown without the override",
    async () => {
      expect(
        await refreshWith(json({ ok: false, error: "invalid_refresh_token" }), {
          resourceMetadataUrl: ROOT_METADATA,
          advertisedResource: MCP_ORIGIN,
          endpointOrigins: [ENDPOINT_ORIGIN],
        }),
      ).toEqual({ status: "unknown" });
    },
  );

  concurrentTest.each([
    ["invalid_code", "exchange_failed"],
    ["invalid_client_id", "client_configuration"],
  ] as const)(
    "fails an exchange answered 200 ok:false %s with %s",
    async (error, failureCode) => {
      const { result } = exchange(
        { token: () => Promise.resolve(json({ ok: false, error })) },
        [],
        slackTarget(),
      );
      expect(await result).toEqual({ status: "failed", failureCode });
    },
  );
});

import { describe, expect } from "bun:test";
import { ManagedOAuthDiscoveryError } from "@/connections/managed-mcp-connection/infra/mcp-oauth-metadata";
import { concurrentTest } from "tests/utils";
import {
  NOW,
  tokenResponse,
  NOTION,
  json,
  providerWith,
  exchange,
  type Stub,
  type Target,
} from "./mcp-oauth-provider-fixtures";

const CUSTOM_RESOURCE = "https://mcp.example.com/v1/mcp";
const CUSTOM_ISSUER_ORIGIN = "https://auth.example.com";
const CUSTOM_ISSUER = `${CUSTOM_ISSUER_ORIGIN}/tenant`;

const CUSTOM: Target = {
  server: {
    resource: CUSTOM_RESOURCE,
    issuerOrigin: CUSTOM_ISSUER_ORIGIN,
    clientRegistration: "dcr",
  },
  preset: null,
  protectedResource: {
    resource: CUSTOM_RESOURCE,
    authorization_servers: [CUSTOM_ISSUER],
  },
  authorizationServer: {
    issuer: CUSTOM_ISSUER,
    authorization_endpoint: `${CUSTOM_ISSUER}/authorize`,
    token_endpoint: `${CUSTOM_ISSUER}/token`,
    registration_endpoint: `${CUSTOM_ISSUER}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  },
  allowedOrigins: ["https://mcp.example.com", CUSTOM_ISSUER_ORIGIN],
};

const customProvider = (stub: Stub = {}, target: Target = CUSTOM) =>
  providerWith(stub, undefined, undefined, target);

const discoveryError = async (
  stub: Stub,
  target: Target = CUSTOM,
): Promise<unknown> => {
  try {
    await customProvider(stub, target).provider.discover();
    return null;
  } catch (caught) {
    return caught;
  }
};

describe("McpOAuthProvider without a preset: discover", () => {
  concurrentTest(
    "accepts a server without iss, revocation or CIMD, using RFC 8414 path insertion",
    async () => {
      const { provider, requests } = customProvider();
      const metadata = await provider.discover();
      expect(metadata).toEqual({
        issuer: CUSTOM_ISSUER,
        resource: CUSTOM_RESOURCE,
        authorizationEndpoint: `${CUSTOM_ISSUER}/authorize`,
        tokenEndpoint: `${CUSTOM_ISSUER}/token`,
        revocationEndpoint: null,
        registrationEndpoint: `${CUSTOM_ISSUER}/register`,
        issParameterSupported: false,
        scopesSupported: [],
      });
      expect(requests.map((request) => request.url)).toEqual([
        "https://mcp.example.com/.well-known/oauth-protected-resource/v1/mcp",
        "https://auth.example.com/.well-known/oauth-authorization-server/tenant",
      ]);
      expect(provider.requiresIssParameter(metadata)).toBe(false);
    },
  );

  concurrentTest("requires iss once the server advertises it", async () => {
    const { provider } = customProvider({
      authorizationServer: {
        authorization_response_iss_parameter_supported: true,
      },
    });
    expect(provider.requiresIssParameter(await provider.discover())).toBe(true);
  });

  const strict: [string, Stub][] = [
    [
      "a different resource",
      { protectedResource: { resource: "https://mcp.example.com/other" } },
    ],
    [
      "an issuer off the stored issuer origin",
      {
        protectedResource: {
          authorization_servers: ["https://evil.example/tenant"],
        },
      },
    ],
    [
      "two candidate issuers on the issuer origin",
      {
        protectedResource: {
          authorization_servers: [CUSTOM_ISSUER, `${CUSTOM_ISSUER_ORIGIN}/b`],
        },
      },
    ],
    [
      "a different authorization server issuer",
      { authorizationServer: { issuer: `${CUSTOM_ISSUER_ORIGIN}/other` } },
    ],
    [
      "no S256",
      { authorizationServer: { code_challenge_methods_supported: ["plain"] } },
    ],
    [
      "no refresh tokens",
      {
        authorizationServer: { grant_types_supported: ["authorization_code"] },
      },
    ],
    [
      "no public-client token auth",
      {
        authorizationServer: {
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
        },
      },
    ],
    [
      "a token endpoint on the resource origin",
      {
        authorizationServer: {
          token_endpoint: "https://mcp.example.com/token",
        },
      },
    ],
    [
      "a revocation endpoint off the issuer origin",
      {
        authorizationServer: {
          revocation_endpoint: "https://mcp.example.com/revoke",
        },
      },
    ],
    [
      "no registration endpoint for a DCR server",
      { authorizationServer: { registration_endpoint: undefined } },
    ],
    [
      "a registration endpoint off the issuer origin",
      {
        authorizationServer: {
          registration_endpoint: "https://evil.example/register",
        },
      },
    ],
  ];

  for (const [name, stub] of strict) {
    concurrentTest(`rejects ${name}`, async () => {
      expect(await discoveryError(stub)).toBeInstanceOf(
        ManagedOAuthDiscoveryError,
      );
    });
  }

  concurrentTest(
    "rejects a CIMD server that doesn't advertise CIMD",
    async () => {
      const cimd: Target = {
        ...CUSTOM,
        server: { ...CUSTOM.server, clientRegistration: "cimd" },
      };
      expect(await discoveryError({}, cimd)).toBeInstanceOf(
        ManagedOAuthDiscoveryError,
      );
      expect(
        await discoveryError(
          {
            authorizationServer: {
              client_id_metadata_document_supported: true,
              registration_endpoint: undefined,
            },
          },
          cimd,
        ),
      ).toBeNull();
    },
  );
});

describe("McpOAuthProvider with the Notion preset: iss", () => {
  concurrentTest(
    "rejects a server that doesn't advertise iss support",
    async () => {
      expect(
        await discoveryError(
          {
            authorizationServer: {
              authorization_response_iss_parameter_supported: undefined,
            },
          },
          NOTION,
        ),
      ).toBeInstanceOf(ManagedOAuthDiscoveryError);
    },
  );

  concurrentTest("requires iss on the callback", async () => {
    const { provider } = providerWith();
    expect(provider.requiresIssParameter(await provider.discover())).toBe(true);
  });
});

describe("McpOAuthProvider without a preset: exchangeCode", () => {
  concurrentTest(
    "stores no identity and never fails for missing identity",
    async () => {
      const { result, requests } = exchange(
        {
          token: () =>
            Promise.resolve(
              json({ ...tokenResponse, workspace_id: undefined, owner: 1 }),
            ),
        },
        [],
        CUSTOM,
      );
      expect(await result).toMatchObject({
        status: "succeeded",
        issuer: CUSTOM_ISSUER,
        resource: CUSTOM_RESOURCE,
        identity: {
          userId: null,
          userName: null,
          workspaceId: null,
          workspaceName: null,
        },
      });
      expect(
        requests.some((request) => request.url === `${CUSTOM_ISSUER}/token`),
      ).toBe(true);
    },
  );
});

describe("McpOAuthProvider without a preset: revoke", () => {
  concurrentTest(
    "reports unconfirmed without sending when there's no revocation endpoint",
    async () => {
      const { provider, requests } = customProvider();
      const outcome = await provider.revoke({
        grant: { clientId: "client-1" } as never,
        credentials: {
          accessToken: "access-1",
          tokenType: "bearer",
          accessExpiresAt: NOW,
          refreshToken: "refresh-1",
        },
      });
      expect(outcome).toBe("unconfirmed");
      expect(
        requests.filter((request) => !request.url.includes("/.well-known/")),
      ).toEqual([]);
    },
  );
});

import { createUuidV7 } from "@/common/contracts/uuid-v7";
import type { ManagedConnectionPreset } from "@/connections/managed-mcp-connection/application/managed-connection-preset";
import type { ManagedConnectionServer } from "@/connections/managed-mcp-connection/domain/managed-connection-server";
import { ManagedOAuthAttemptEntity } from "@/connections/managed-mcp-connection/domain/managed-oauth-attempt-entity";
import { GuardedFetch } from "@/connections/managed-mcp-connection/infra/guarded-fetch";
import {
  MANAGED_CONNECTION_PRESETS,
  managedConnectionDefinitionFromPreset,
} from "@/connections/managed-mcp-connection/infra/managed-connection-presets";
import { McpOAuthProvider } from "@/connections/managed-mcp-connection/infra/mcp-oauth-provider";
import { cimdClientIdentity } from "@/connections/managed-mcp-connection/infra/cimd-client-registry";

/** Stubbed-fetch fixtures for {@link McpOAuthProvider} unit tests. */
export const NOW = new Date("2026-11-17T12:00:00.000Z");

export const NOTION_SERVER =
  managedConnectionDefinitionFromPreset("notion").server;
export const NOTION_MCP_ORIGIN = NOTION_SERVER.issuerOrigin;
export const NOTION_MCP_RESOURCE = NOTION_SERVER.resource;

export const protectedResource = {
  resource: NOTION_MCP_RESOURCE,
  authorization_servers: [NOTION_MCP_ORIGIN],
  scopes_supported: ["default"],
};

export const authorizationServer = {
  issuer: NOTION_MCP_ORIGIN,
  authorization_endpoint: `${NOTION_MCP_ORIGIN}/authorize`,
  token_endpoint: `${NOTION_MCP_ORIGIN}/token`,
  revocation_endpoint: `${NOTION_MCP_ORIGIN}/token`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
  authorization_response_iss_parameter_supported: true,
  client_id_metadata_document_supported: true,
};

export const tokenResponse = {
  access_token: "access-1",
  token_type: "bearer",
  expires_in: 3600,
  refresh_token: "refresh-1",
  scope: "default",
  workspace_id: "ws-1",
  workspace_name: "Workspace",
  owner: { type: "user", user: { id: "user-1", name: "User" } },
  something_new: 1,
};

export type Stub = {
  protectedResource?: Record<string, unknown>;
  authorizationServer?: Record<string, unknown>;
  token?: () => Promise<Response>;
};

export type Target = {
  server: ManagedConnectionServer;
  preset: ManagedConnectionPreset | null;
  protectedResource: Record<string, unknown>;
  authorizationServer: Record<string, unknown>;
  allowedOrigins: string[];
};

export const NOTION: Target = {
  server: NOTION_SERVER,
  preset: MANAGED_CONNECTION_PRESETS.notion,
  protectedResource,
  authorizationServer,
  allowedOrigins: [NOTION_MCP_ORIGIN],
};

export const json = (body: object, status = 200) =>
  new Response(JSON.stringify(body), { status });

export const providerWith = (
  stub: Stub = {},
  timeoutMs?: number,
  now: () => Date = () => NOW,
  target: Target = NOTION,
) => {
  const requests: { url: string; body: string }[] = [];
  const fetchImpl = async (input: URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    requests.push({ url: input.toString(), body });
    if (input.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json({ ...target.protectedResource, ...stub.protectedResource });
    }
    if (input.pathname.startsWith("/.well-known/oauth-authorization-server")) {
      return json({
        ...target.authorizationServer,
        ...stub.authorizationServer,
      });
    }
    if (input.pathname.endsWith("/token")) {
      return stub.token
        ? await stub.token()
        : json(new URLSearchParams(body).has("token") ? {} : tokenResponse);
    }
    return json({}, 404);
  };
  const provider = new McpOAuthProvider({
    guardedFetch: new GuardedFetch({
      allowedOrigins: target.allowedOrigins,
      resolveHost: () => Promise.resolve(["104.18.10.10"]),
      fetchImpl: fetchImpl as typeof fetch,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }),
    timeProvider: { now, nowIso: () => now().toISOString() },
    server: target.server,
    preset: target.preset,
  });
  return { provider, requests };
};

export const encrypted = {
  ciphertext: Buffer.from("c"),
  iv: Buffer.from("i"),
  authTag: Buffer.from("t"),
  keyVersion: 1,
};

/** Scarn's CIMD identity under the fixtures' API base URL. */
export const CLIENT_IDENTITY = cimdClientIdentity(
  "https://app.scarn.test/api/",
);

export const attempt = (requestedScopes: string[] = []) => {
  const identity = CLIENT_IDENTITY;
  return ManagedOAuthAttemptEntity.create({
    id: createUuidV7(),
    connectionId: createUuidV7(),
    projectId: createUuidV7(),
    kind: "connect",
    expectedGeneration: 0,
    actorUserId: createUuidV7(),
    binding: { kind: "browser", sessionDigest: "session-digest" },
    stateDigest: "state-digest",
    clientId: identity.clientId,
    redirectUri: identity.redirectUri,
    requestedScopes,
    encryptedPkceVerifier: encrypted,
    now: NOW,
  });
};

export const exchange = (
  stub: Stub,
  requestedScopes: string[] = [],
  target: Target = NOTION,
) => {
  const { provider, requests } = providerWith(
    stub,
    undefined,
    undefined,
    target,
  );
  return {
    requests,
    result: provider.exchangeCode({
      attempt: attempt(requestedScopes),
      code: "code-1",
      pkceVerifier: "verifier-1",
    }),
  };
};

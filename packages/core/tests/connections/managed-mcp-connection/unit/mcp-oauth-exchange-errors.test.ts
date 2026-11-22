import { describe, expect } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { ManagedOAuthAttemptEntity } from "@/connections/managed-mcp-connection/domain/managed-oauth-attempt-entity";
import type { ManagedOAuthAttemptFailureCode } from "@/connections/managed-mcp-connection/domain/managed-oauth-attempt-entity";
import { cimdClientIdentity } from "@/connections/managed-mcp-connection/infra/cimd-client-registry";
import { GuardedFetch } from "@/connections/managed-mcp-connection/infra/guarded-fetch";
import {
  managedConnectionDefinitionFromPreset,
  MANAGED_CONNECTION_PRESETS,
} from "@/connections/managed-mcp-connection/infra/managed-connection-presets";
import { McpOAuthProvider } from "@/connections/managed-mcp-connection/infra/mcp-oauth-provider";
import { concurrentTest } from "tests/utils";

const ORIGIN = "https://mcp.notion.com";
const SECRET = "canary-sensitive-provider-value";
const tokenResponse = {
  access_token: SECRET,
  token_type: "bearer",
  expires_in: 3600,
  refresh_token: SECRET,
  scope: "default",
  workspace_id: SECRET,
  workspace_name: SECRET,
  owner: { user: { id: SECRET, name: SECRET } },
};
const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status });

const exchange = async (token: () => Promise<Response>) => {
  let tokenCalls = 0;
  const fetchImpl = async (url: URL) => {
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return json({
        resource: `${ORIGIN}/mcp`,
        authorization_servers: [ORIGIN],
      });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json({
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/authorize`,
        token_endpoint: `${ORIGIN}/token`,
        revocation_endpoint: `${ORIGIN}/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        authorization_response_iss_parameter_supported: true,
        client_id_metadata_document_supported: true,
      });
    }
    tokenCalls++;
    return token();
  };
  const now = new Date("2026-11-17T12:00:00Z");
  const provider = new McpOAuthProvider({
    guardedFetch: new GuardedFetch({
      allowedOrigins: [ORIGIN],
      resolveHost: () => Promise.resolve(["104.18.10.10"]),
      fetchImpl: fetchImpl as typeof fetch,
    }),
    timeProvider: { now: () => now, nowIso: () => now.toISOString() },
    server: managedConnectionDefinitionFromPreset("notion").server,
    preset: MANAGED_CONNECTION_PRESETS.notion,
  });
  const attempt = ManagedOAuthAttemptEntity.create({
    id: createUuidV7(),
    connectionId: createUuidV7(),
    projectId: createUuidV7(),
    actorUserId: createUuidV7(),
    kind: "connect",
    expectedGeneration: 0,
    binding: { kind: "browser", sessionDigest: SECRET },
    stateDigest: SECRET,
    ...cimdClientIdentity("https://scarn.test/api"),
    requestedScopes: [],
    encryptedPkceVerifier: {
      ciphertext: Buffer.from(SECRET),
      iv: Buffer.from("i"),
      authTag: Buffer.from("t"),
      keyVersion: 1,
    },
    now,
  });
  const result = await provider.exchangeCode({
    attempt,
    code: SECRET,
    pkceVerifier: SECRET,
  });
  expect(JSON.stringify(result)).not.toContain(SECRET);
  return { result, tokenCalls };
};

describe("MCP OAuth exchange errors with the Notion preset", () => {
  concurrentTest(
    "maps OAuth errors without exposing provider values or retrying",
    async () => {
      for (const error of ["invalid_grant", "invalid_client", SECRET]) {
        const failureCode =
          error === "invalid_client"
            ? "client_configuration"
            : "exchange_failed";
        const { result, tokenCalls } = await exchange(() =>
          Promise.resolve(
            json(
              {
                error,
                error_description: SECRET,
                ...tokenResponse,
              },
              400,
            ),
          ),
        );
        expect(result).toEqual({ status: "failed", failureCode });
        expect(tokenCalls).toBe(1);
      }
    },
  );

  concurrentTest(
    "rejects malformed fields without exposing validation values",
    async () => {
      const cases: [Record<string, unknown>, ManagedOAuthAttemptFailureCode][] =
        [
          [{ scope: [SECRET] }, "exchange_failed"],
          [{ expires_in: SECRET }, "missing_expiry"],
          [{ refresh_token: "" }, "missing_refresh"],
          [{ access_token: "" }, "exchange_failed"],
          [{ token_type: SECRET }, "exchange_failed"],
          [{ owner: undefined, workspace_id: undefined }, "missing_identity"],
          [
            { owner: { user: { id: { [SECRET]: SECRET } } } },
            "exchange_failed",
          ],
        ];
      for (const [overrides, failureCode] of cases) {
        const { result } = await exchange(() =>
          Promise.resolve(json({ ...tokenResponse, ...overrides })),
        );
        expect(result).toEqual({ status: "failed", failureCode });
      }
    },
  );

  concurrentTest(
    "does not expose malformed response bodies or thrown errors",
    async () => {
      for (const token of [
        () => Promise.resolve(new Response(SECRET)),
        () => Promise.resolve(new Response(SECRET, { status: 400 })),
        () => Promise.reject(new Error(SECRET)),
      ]) {
        const { result, tokenCalls } = await exchange(token);
        expect(result.status).toBe("failed");
        expect(tokenCalls).toBe(1);
      }
    },
  );
});

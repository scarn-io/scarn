import { describe, expect } from "bun:test";
import {
  CimdClientRegistry,
  cimdClientIdentity,
} from "@/connections/managed-mcp-connection/infra/cimd-client-registry";
import {
  managedOAuthClientIdentityFor,
  managedOAuthClientMetadataDocument,
} from "@/connections/managed-mcp-connection/contracts/managed-oauth-client-metadata";
import type { ManagedConnectionServer } from "@/connections/managed-mcp-connection/domain/managed-connection-server";
import type { ManagedOAuthServerMetadata } from "@/connections/managed-mcp-connection/application/oauth-provider";
import { CoreError } from "@/lib/errors";
import { concurrentTest } from "tests/utils";

const API_BASE_URL = "https://scarn.example.test/api";

describe("managedOAuthClientIdentityFor", () => {
  concurrentTest(
    "derives the client ID and redirect URI from the deployment's API URL",
    () => {
      expect(managedOAuthClientIdentityFor(`${API_BASE_URL}//`)).toEqual({
        clientId: `${API_BASE_URL}/oauth/mcp/client-metadata.json`,
        redirectUri: `${API_BASE_URL}/oauth/mcp/callback`,
      });
    },
  );

  concurrentTest("the CIMD document declares the derived identity", () => {
    const document = managedOAuthClientMetadataDocument(
      managedOAuthClientIdentityFor(API_BASE_URL),
    );
    expect(document.client_id).toBe(
      `${API_BASE_URL}/oauth/mcp/client-metadata.json`,
    );
    expect(document.redirect_uris[0]).toBe(
      `${API_BASE_URL}/oauth/mcp/callback`,
    );
    expect(document.token_endpoint_auth_method).toBe("none");
  });
});

describe("cimdClientIdentity", () => {
  concurrentTest("throws MISSING_CONFIG without an API URL", () => {
    let caught: unknown;
    try {
      cimdClientIdentity(null);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CoreError);
    expect((caught as CoreError).code).toBe("MISSING_CONFIG");
  });
});

describe("CimdClientRegistry", () => {
  const server = {} as ManagedConnectionServer;
  const metadata = {} as ManagedOAuthServerMetadata;

  concurrentTest(
    "resolves the identity under the configured API URL",
    async () => {
      const registry = new CimdClientRegistry(API_BASE_URL);
      expect(await registry.resolve(server, metadata, null)).toEqual(
        managedOAuthClientIdentityFor(API_BASE_URL),
      );
    },
  );

  concurrentTest(
    "keeps the client ID but uses the loopback redirect",
    async () => {
      const registry = new CimdClientRegistry(API_BASE_URL);
      expect(
        await registry.resolve(
          server,
          metadata,
          "http://127.0.0.1:5555/callback",
        ),
      ).toEqual({
        clientId: `${API_BASE_URL}/oauth/mcp/client-metadata.json`,
        redirectUri: "http://127.0.0.1:5555/callback",
      });
    },
  );
});

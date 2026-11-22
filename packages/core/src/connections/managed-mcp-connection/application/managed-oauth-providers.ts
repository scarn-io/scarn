import { managedConnectionDiscoveryKey } from "../domain/managed-connection-discovery";
import type { ManagedConnectionServer } from "../domain/managed-connection-server";
import type { ManagedOAuthProvider } from "./oauth-provider";

/** What a provider is built from: a connection's stored server and preset key. */
export type ManagedOAuthProviderTarget = {
  server: ManagedConnectionServer;
  preset: string | null;
};

/**
 * Hands out the OAuth provider for one connection's server. Each provider
 * reaches only that server's MCP origin and issuer origin.
 */
export interface ManagedOAuthProviders {
  for(connection: ManagedOAuthProviderTarget): ManagedOAuthProvider;
}

const suppliedClientOf = (server: ManagedConnectionServer): string =>
  server.clientRegistration === "supplied"
    ? `${server.suppliedClientId} ${server.suppliedRedirectUri}`
    : "";

const scopesOf = (server: ManagedConnectionServer): string =>
  server.scopes === undefined ? "" : JSON.stringify(server.scopes);

/**
 * Whether two connections would get the same provider and client, and sign
 * in asking for the same scopes.
 */
export const sameManagedConnectionTarget = (
  a: ManagedOAuthProviderTarget,
  b: ManagedOAuthProviderTarget,
): boolean =>
  a.preset === b.preset &&
  scopesOf(a.server) === scopesOf(b.server) &&
  a.server.resource === b.server.resource &&
  a.server.issuerOrigin === b.server.issuerOrigin &&
  a.server.clientRegistration === b.server.clientRegistration &&
  managedConnectionDiscoveryKey(a.server.discovery) ===
    managedConnectionDiscoveryKey(b.server.discovery) &&
  suppliedClientOf(a.server) === suppliedClientOf(b.server);

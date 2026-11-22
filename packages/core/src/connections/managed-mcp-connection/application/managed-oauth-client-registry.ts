import { CoreError } from "@scarn/core/lib/errors";
import type { ManagedConnectionServer } from "../domain/managed-connection-server";
import type {
  ManagedOAuthClientIdentity,
  ManagedOAuthServerMetadata,
} from "./oauth-provider";

/**
 * Who Scarn is to a connection's authorization server (ADR 0013 decision 43).
 * With CIMD the client ID is Scarn's metadata document URL; with DCR it is
 * the client Scarn registered with that server, shared by every connection
 * to it. Grants keep the client ID they were issued to, so refresh and
 * revoke never ask the registry.
 */
export interface ManagedOAuthClientRegistry {
  /**
   * The client to start an authorization with, and the exact redirect URI
   * the attempt sends and the token request repeats. `loopbackRedirectUri`
   * is the CLI's listener for a loopback attempt, or null for the server
   * callback. With DCR, registers a client first when the server has no live
   * one for that redirect; a loopback attempt uses the client registered for
   * the portless loopback redirect, or for the fixed fallback port when the
   * server won't let the port vary. `metadata` is `server`'s checked
   * metadata. Throws `MANAGED_CONNECTION_CLIENT_CONFIGURATION` when a
   * registration response can't be used, and
   * `MANAGED_CONNECTION_PROVIDER_UNAVAILABLE` when the registration request
   * failed.
   */
  resolve(
    server: ManagedConnectionServer,
    metadata: ManagedOAuthServerMetadata,
    loopbackRedirectUri: string | null,
  ): Promise<ManagedOAuthClientIdentity>;
  /**
   * Records that `issuer` no longer recognises `clientId` (`invalid_client`),
   * so the next connect registers again. A no-op for clients Scarn didn't
   * register.
   */
  markStale(issuer: string, clientId: string): Promise<void>;
}

/**
 * The authorization server's registration response broke Scarn's public
 * client rules (a secret, another auth method or other redirect URIs) or
 * wasn't a registration at all. Nothing it sent is in the error.
 */
export const managedOAuthClientConfigurationError = () =>
  new CoreError({
    code: "MANAGED_CONNECTION_CLIENT_CONFIGURATION",
    message:
      "The authorization server registered Scarn in a way Scarn can't use",
    status: 502,
    meta: { reasonCode: "client_configuration" },
  });

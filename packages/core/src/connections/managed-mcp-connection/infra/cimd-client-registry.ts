import { CoreError } from "@scarn/core/lib/errors";
import { managedOAuthClientIdentityFor } from "../contracts/managed-oauth-client-metadata";
import type { ManagedOAuthClientRegistry } from "../application/managed-oauth-client-registry";
import type { ManagedConnectionServer } from "../domain/managed-connection-server";
import type {
  ManagedOAuthClientIdentity,
  ManagedOAuthServerMetadata,
} from "../application/oauth-provider";

/**
 * Scarn's CIMD client identity: its `client_id` is the URL its Client ID
 * Metadata Document is served at, and its redirect URI is the OAuth
 * callback, both under the API's public base URL. Throws `MISSING_CONFIG`
 * when that URL isn't configured.
 */
export const cimdClientIdentity = (
  apiBaseUrl: string | null,
): ManagedOAuthClientIdentity => {
  if (!apiBaseUrl) {
    throw new CoreError({
      code: "MISSING_CONFIG",
      message: "APP_URL environment variable is not set",
      status: 500,
    });
  }
  return managedOAuthClientIdentityFor(apiBaseUrl);
};

/**
 * The registry for servers that accept Client ID Metadata Documents. Nothing
 * is registered or stored: every connection uses Scarn's one CIMD identity,
 * and there is nothing to mark stale. A loopback attempt uses the CLI's
 * redirect, which the document's portless loopback redirect covers when the
 * server lets the port vary (decision 7); there is no fallback.
 */
export class CimdClientRegistry implements ManagedOAuthClientRegistry {
  private readonly apiBaseUrl: string | null;

  constructor(apiBaseUrl: string | null) {
    this.apiBaseUrl = apiBaseUrl;
  }

  resolve(
    _server: ManagedConnectionServer,
    _metadata: ManagedOAuthServerMetadata,
    loopbackRedirectUri: string | null,
  ): Promise<ManagedOAuthClientIdentity> {
    const identity = cimdClientIdentity(this.apiBaseUrl);
    return Promise.resolve(
      loopbackRedirectUri === null
        ? identity
        : { clientId: identity.clientId, redirectUri: loopbackRedirectUri },
    );
  }

  markStale(): Promise<void> {
    return Promise.resolve();
  }
}

import {
  MANAGED_CONNECTION_LOOPBACK_CALLBACK_PATH,
  MANAGED_CONNECTION_LOOPBACK_FALLBACK_PORT,
} from "@scarn/sdk/managed-connections";
import { z } from "zod";

/**
 * Scarn's OAuth Client ID Metadata Document (CIMD). Scarn is a public client
 * whose `client_id` is the HTTPS URL this document is served at, so the
 * document and the `client_id`/redirect URI sent to the provider all derive
 * from one place: the API's public base URL (`${APP_URL}/api`).
 */
export const MANAGED_OAUTH_CLIENT_METADATA_PATH =
  "/oauth/mcp/client-metadata.json";
export const MANAGED_OAUTH_CALLBACK_PATH = "/oauth/mcp/callback";
export const MANAGED_OAUTH_CLIENT_NAME = "Scarn";

/**
 * The loopback redirect Scarn registers for CLI sign-ins, without a port:
 * the CLI binds any free port and the server lets it vary (decision 7).
 */
export const MANAGED_OAUTH_LOOPBACK_REDIRECT_URI = `http://127.0.0.1${MANAGED_CONNECTION_LOOPBACK_CALLBACK_PATH}`;

/** The loopback redirect for servers that match redirect URIs exactly, port included. */
export const MANAGED_OAUTH_LOOPBACK_FALLBACK_REDIRECT_URI = `http://127.0.0.1:${String(MANAGED_CONNECTION_LOOPBACK_FALLBACK_PORT)}${MANAGED_CONNECTION_LOOPBACK_CALLBACK_PATH}`;

const LOOPBACK_REDIRECT_PORT =
  /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/callback$/u;

/**
 * Whether `redirectUri` is a loopback redirect the portless one covers:
 * `http://127.0.0.1:<port>/callback` on any port.
 */
export const matchesManagedOAuthLoopbackRedirect = (
  redirectUri: string,
): boolean => {
  const port = LOOPBACK_REDIRECT_PORT.exec(redirectUri)?.[1];
  return port !== undefined && Number(port) >= 1 && Number(port) <= 65_535;
};

export const managedOAuthClientMetadataDocumentSchema = z.object({
  client_id: z.string(),
  client_name: z.string(),
  redirect_uris: z.array(z.string()),
  grant_types: z.array(z.string()),
  response_types: z.array(z.string()),
  token_endpoint_auth_method: z.string(),
});

export type ManagedOAuthClientMetadataDocument = z.infer<
  typeof managedOAuthClientMetadataDocumentSchema
>;

const TRAILING_SLASHES = /\/+$/u;

/** `apiBaseUrl` is the API's public base URL, including the `/api` mount. */
export const managedOAuthClientIdentityFor = (
  apiBaseUrl: string,
): { clientId: string; redirectUri: string } => {
  const base = apiBaseUrl.trim().replace(TRAILING_SLASHES, "");
  return {
    clientId: `${base}${MANAGED_OAUTH_CLIENT_METADATA_PATH}`,
    redirectUri: `${base}${MANAGED_OAUTH_CALLBACK_PATH}`,
  };
};

/** What Scarn declares about itself as a client, minus `client_id`. */
export type ManagedOAuthClientMetadata = Omit<
  ManagedOAuthClientMetadataDocument,
  "client_id"
>;

/**
 * Scarn's client metadata for `redirectUri`: a public client (no secret)
 * using the authorization code and refresh token grants. Both the CIMD
 * document and a dynamic client registration request (RFC 7591) declare it.
 */
export const managedOAuthClientMetadata = (
  redirectUri: string,
): ManagedOAuthClientMetadata => ({
  client_name: MANAGED_OAUTH_CLIENT_NAME,
  redirect_uris: [redirectUri],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
});

/**
 * Scarn's CIMD document: its server callback, plus the portless loopback
 * redirect the CLI catches a sign-in on. Servers let the loopback port vary
 * (RFC 8252 §7.3), so the CLI's dynamic port matches it.
 */
export const managedOAuthClientMetadataDocument = (identity: {
  clientId: string;
  redirectUri: string;
}): ManagedOAuthClientMetadataDocument => ({
  client_id: identity.clientId,
  ...managedOAuthClientMetadata(identity.redirectUri),
  redirect_uris: [identity.redirectUri, MANAGED_OAUTH_LOOPBACK_REDIRECT_URI],
});

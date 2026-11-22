import type { ManagedConnectionServer } from "../domain/managed-connection-server";

/**
 * How an authorization server answered a probe of its authorization
 * endpoint: `rejected` is a 4xx (it refused the client or redirect URI),
 * `accepted` is a 2xx or a redirect (a login or consent page, or straight
 * back to the redirect URI), and `unknown` is anything else, a 5xx or a
 * request that failed.
 */
export type ManagedOAuthAuthorizeProbeResult =
  "accepted" | "rejected" | "unknown";

/**
 * Asks `server`'s authorization endpoint, once and without following
 * redirects, whether it would start an authorization at `authorizationUrl`.
 * Loopback DCR uses it to learn whether the server lets a loopback
 * redirect's port vary (RFC 8252 §7.3), since a refusal at authorize
 * happens in the user's browser where neither the CLI nor Scarn sees it.
 */
export interface ManagedOAuthAuthorizeProbe {
  probe(
    server: ManagedConnectionServer,
    authorizationUrl: string,
  ): Promise<ManagedOAuthAuthorizeProbeResult>;
}

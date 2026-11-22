import { createHash } from "node:crypto";
import type { ManagedOAuthServerMetadata } from "../application/oauth-provider";

export const pkceS256Challenge = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

/**
 * The authorization request (RFC 6749 §4.1.1 with PKCE S256 and RFC 8707
 * `resource`) for `clientId` at `redirectUri`, against `metadata`'s
 * authorization endpoint.
 */
export const managedOAuthAuthorizationUrl = (input: {
  metadata: ManagedOAuthServerMetadata;
  clientId: string;
  redirectUri: string;
  state: string;
  pkceVerifier: string;
  scopes: readonly string[];
}): string => {
  const url = new URL(input.metadata.authorizationEndpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    state: input.state,
    code_challenge: pkceS256Challenge(input.pkceVerifier),
    code_challenge_method: "S256",
    resource: input.metadata.resource,
    ...(input.scopes.length > 0 ? { scope: input.scopes.join(" ") } : {}),
  }).toString();
  return url.toString();
};

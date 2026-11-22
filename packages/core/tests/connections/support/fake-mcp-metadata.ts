import type { FakeMcpClientMode } from "./fake-mcp-clients";

/**
 * The authorization-server metadata {@link FakeMcpOAuth} serves when it
 * isn't Slack-like: every endpoint on `origin`, with revocation, a
 * registration endpoint, CIMD and `iss` as configured.
 */
export const fakeAuthorizationServerMetadata = (options: {
  origin: string;
  revocation: boolean;
  clientMode: FakeMcpClientMode;
  issParameterSupported: boolean;
}): Record<string, unknown> => ({
  issuer: options.origin,
  authorization_endpoint: `${options.origin}/authorize`,
  token_endpoint: `${options.origin}/token`,
  ...(options.revocation
    ? { revocation_endpoint: `${options.origin}/token` }
    : {}),
  ...(options.clientMode === "supplied"
    ? {}
    : { registration_endpoint: `${options.origin}/register` }),
  scopes_supported: ["default"],
  response_types_supported: ["code"],
  response_modes_supported: ["query"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  token_endpoint_auth_methods_supported: [
    "client_secret_basic",
    "client_secret_post",
    "none",
  ],
  code_challenge_methods_supported: ["S256"],
  authorization_response_iss_parameter_supported: options.issParameterSupported,
  client_id_metadata_document_supported: options.clientMode === "cimd",
});

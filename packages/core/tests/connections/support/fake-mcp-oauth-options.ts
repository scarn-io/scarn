import type { FakeMcpServerFault } from "./fake-mcp-server";

/** Options, faults and recorded calls of {@link FakeMcpOAuth}. */

export type FakeMcpAuthorizeFault = "missing_iss" | "wrong_iss";
export type FakeMcpTokenFault =
  "no_refresh_token" | "no_scope" | "slow" | "server_error" | "invalid_client";
export type FakeMcpRefreshFault =
  | "invalid_grant"
  | "invalid_client"
  | "slow"
  | "server_error"
  | "drop_response_after_rotate"
  | "no_refresh_token"
  | "no_expires_in";
export type FakeMcpRevokeFault = "slow" | "server_error";
export type FakeMcpRegisterFault =
  | "client_secret"
  | "other_auth_method"
  | "other_redirect_uris"
  | "server_error"
  | "slow";

export type FakeMcpFaults = {
  authorize?: FakeMcpAuthorizeFault;
  token?: FakeMcpTokenFault;
  refresh?: FakeMcpRefreshFault;
  revoke?: FakeMcpRevokeFault;
  register?: FakeMcpRegisterFault;
  mcp?: FakeMcpServerFault;
};

export type FakeMcpIdentity = {
  userId: string;
  userName: string;
  workspaceId: string;
  workspaceName: string;
};

export type FakeMcpCall = {
  endpoint:
    | "protected_resource_metadata"
    | "authorization_server_metadata"
    | "authorize"
    | "token"
    | "refresh"
    | "revoke"
    | "register"
    | "unknown";
  method: string;
  path: string;
  params: Record<string, string>;
};

export type FakeMcpIssuedCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  used: boolean;
};

export type FakeMcpIssuedRefreshToken = {
  clientId: string;
  resource: string;
  used: boolean;
  /** The access token issued alongside, retired when this one is spent. */
  accessToken: string | null;
};

export type FakeMcpOptions = {
  identity?: FakeMcpIdentity;
  /** How the client identifies itself; `cimd` by default. */
  clientRegistration?: "cimd" | "dcr";
  /**
   * A pre-registered public client, as a user would supply from their MCP
   * config. When set, it is the only client the fake knows: `/authorize`
   * matches its redirect exactly, and metadata advertises neither CIMD nor a
   * registration endpoint. Overrides `clientRegistration`.
   */
  suppliedClient?: { clientId: string; redirectUri: string };
  /** Whether metadata advertises, and the callback carries, `iss`; true by default. */
  issParameterSupported?: boolean;
  /** Whether metadata advertises a revocation endpoint; true by default. */
  revocation?: boolean;
  /** Whether the token response carries Notion's identity fields or none; `notion` by default. */
  identityShape?: "notion" | "none";
  /**
   * Whether `/authorize` matches `redirect_uri` exactly against the client's
   * registered redirects. By default a registered loopback IP redirect
   * matches on any port, as RFC 8252 §7.3 asks; false by default.
   */
  strictRedirects?: boolean;
  /**
   * Behave like Slack's MCP server (see `FakeMcpSlack`): needs
   * `suppliedClient`, turns off `iss`, revocation and identity, and serves
   * `/authorize` and `/token` only on a second loopback origin,
   * `endpointOrigin`.
   */
  slackLike?: boolean;
  /** Prefixes the names of the tools `/mcp` lists. */
  toolPrefix?: string;
  scopes?: readonly string[];
  /** Fetches the CIMD document at a `client_id` URL; defaults to `fetch`. */
  fetchClientMetadata?: (url: string) => Promise<Response>;
  slowMs?: number;
};

/** The options for a fake of an MCP server without a preset: no `iss`, no revocation, no identity. */
export const FAKE_MCP_NO_PRESET = {
  issParameterSupported: false,
  revocation: false,
  identityShape: "none",
} as const satisfies FakeMcpOptions;

export const DEFAULT_FAKE_MCP_IDENTITY: FakeMcpIdentity = {
  userId: "fake-user-1",
  userName: "Fake User",
  workspaceId: "fake-workspace-1",
  workspaceName: "Fake Workspace",
};

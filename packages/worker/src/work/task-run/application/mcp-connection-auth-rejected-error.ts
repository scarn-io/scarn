import { MCP_CONNECTION_AUTH_INVALID_ERROR_CODE } from "../infra/mcp-server-ref-resolver";

/**
 * Thrown before OpenCode starts when launch registration refuses the step's
 * MCP servers with `SCARN_MCP_CONNECTION_AUTH_INVALID`: a connection-auth
 * server's URL isn't its connection's, or a server without `auth` points at
 * a connection's URL. Carries the server's message, which names the key,
 * the connection and the URL to use.
 */
export class McpConnectionAuthRejectedError extends Error {
  readonly code = MCP_CONNECTION_AUTH_INVALID_ERROR_CODE;

  constructor(detail: string | undefined) {
    super(
      detail ??
        "Launch registration refused the step's MCP servers: a server's URL doesn't match its connection.",
    );
    this.name = "McpConnectionAuthRejectedError";
  }
}

import type { McpHandshakeReport } from "./poll-mcp-status";

/** Failure code for a run stopped by the MCP startup gate (decision 10). */
export const CONNECTOR_UNAVAILABLE_ERROR_CODE = "SCARN_CONNECTOR_UNAVAILABLE";

/** The named error a pipeline's `retry`/`catch` matches for an unavailable connector or step MCP server. */
export const CONNECTOR_UNAVAILABLE_ERROR_NAME = "Scarn.ConnectorUnavailable";

/**
 * Thrown before the first prompt when a connector or step `mcps` server is not
 * `connected` (see `mcp-startup-gate.ts`). The message lists every failing
 * server with its status and OpenCode's error.
 */
export class ConnectorUnavailableError extends Error {
  readonly servers: readonly McpHandshakeReport[];

  constructor(servers: readonly McpHandshakeReport[]) {
    super(
      `MCP servers not connected: ${servers
        .map(
          (server) =>
            `${server.name} (${server.status}${server.error ? `: ${server.error}` : ""})`,
        )
        .join("; ")}`,
    );
    this.name = "ConnectorUnavailableError";
    this.servers = servers;
  }
}

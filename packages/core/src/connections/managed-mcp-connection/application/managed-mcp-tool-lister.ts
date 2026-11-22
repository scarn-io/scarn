import type { AnyJsonObject } from "@scarn/core/common/contracts/json";
import type { ManagedMcpServerTarget } from "./managed-mcp-passthrough";

/** One tool a managed MCP server offers, as data parsed from `tools/list`. */
export type ManagedMcpTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: AnyJsonObject;
  /** The tool's declared structured-output JSON Schema, verbatim. */
  outputSchema?: AnyJsonObject;
  readOnlyHint?: boolean;
};

/**
 * `unauthorized`: the server rejected the access token. `unavailable`: any
 * other failure (refused destination, redirect, oversize, timeout, protocol
 * error, too many pages). Neither carries anything the server sent.
 */
export type ManagedMcpToolListFailure = "unauthorized" | "unavailable";

export type ManagedMcpToolListResult =
  | { status: "listed"; tools: ManagedMcpTool[] }
  | { status: "failed"; failure: ManagedMcpToolListFailure };

/** Lists the tools of a connection's MCP server, authenticated with `accessToken`. */
export interface ManagedMcpToolLister {
  listTools(input: {
    server: ManagedMcpServerTarget;
    accessToken: string;
  }): Promise<ManagedMcpToolListResult>;
}

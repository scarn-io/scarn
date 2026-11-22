import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AnyJsonObject } from "@scarn/core/common/contracts/json";
import type {
  ManagedMcpTool,
  ManagedMcpToolLister,
  ManagedMcpToolListResult,
} from "../application/managed-mcp-tool-lister";
import type { ManagedMcpServerTarget } from "../application/managed-mcp-passthrough";
import { GuardedMcpFetch } from "./guarded-mcp-fetch";
import type { ManagedConnectionGuards } from "./managed-connection-guards";

/** `tools/list` pages read before giving up on a server that keeps paginating. */
export const MANAGED_MCP_MAX_TOOL_PAGES = 10;

export type SdkManagedMcpToolListerOptions = {
  guards: ManagedConnectionGuards;
  /** Overrides the session's 20 s deadline. */
  timeoutMs?: number;
  /** Overrides the session's 2 MiB byte cap. */
  maxResponseBytes?: number;
};

class TooManyPagesError extends Error {}

/**
 * {@link ManagedMcpToolLister} over the official MCP SDK client: Streamable
 * HTTP only (no SSE fallback), `initialize`, then up to
 * {@link MANAGED_MCP_MAX_TOOL_PAGES} `tools/list` pages, then the session is
 * deleted and the client closed. Every request goes through one guarded
 * session over the connection's guard from {@link ManagedConnectionGuards},
 * so the byte cap and deadline cover the whole exchange. Errors are reduced
 * to `unauthorized` or `unavailable`; nothing the server sent is kept.
 */
export class SdkManagedMcpToolLister implements ManagedMcpToolLister {
  private readonly options: SdkManagedMcpToolListerOptions;

  constructor(options: SdkManagedMcpToolListerOptions) {
    this.options = options;
  }

  async listTools(input: {
    server: ManagedMcpServerTarget;
    accessToken: string;
  }): Promise<ManagedMcpToolListResult> {
    const session = new GuardedMcpFetch({
      guardedFetch: this.options.guards.for(input.server),
      ...(this.options.timeoutMs === undefined
        ? {}
        : { timeoutMs: this.options.timeoutMs }),
      ...(this.options.maxResponseBytes === undefined
        ? {}
        : { maxResponseBytes: this.options.maxResponseBytes }),
    }).session();
    const { signal } = session;
    const transport = new StreamableHTTPClientTransport(
      new URL(input.server.resource),
      {
        fetch: session.fetch,
        requestInit: {
          headers: { Authorization: `Bearer ${input.accessToken}` },
        },
      },
    );
    const client = new Client({
      name: "scarn-managed-connection",
      version: "0",
    });
    try {
      await client.connect(transport, { signal });
      const tools: ManagedMcpTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; ; page += 1) {
        if (page === MANAGED_MCP_MAX_TOOL_PAGES) {
          throw new TooManyPagesError();
        }
        const result = await client.listTools(
          cursor === undefined ? undefined : { cursor },
          { signal },
        );
        tools.push(...result.tools.map(toManagedTool));
        cursor = result.nextCursor;
        if (cursor === undefined) {
          break;
        }
      }
      return { status: "listed", tools };
    } catch {
      return {
        status: "failed",
        failure:
          session.unauthorized && session.failure === null
            ? "unauthorized"
            : "unavailable",
      };
    } finally {
      if (!signal.aborted) {
        await transport.terminateSession().catch(() => undefined);
      }
      await client.close().catch(() => undefined);
    }
  }
}

function toManagedTool(tool: Tool): ManagedMcpTool {
  const readOnlyHint = tool.annotations?.readOnlyHint;
  return {
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    ...(tool.description === undefined
      ? {}
      : { description: tool.description }),
    inputSchema: toJsonObject(tool.inputSchema),
    ...(tool.outputSchema === undefined
      ? {}
      : { outputSchema: toJsonObject(tool.outputSchema) }),
    ...(readOnlyHint === undefined ? {} : { readOnlyHint }),
  };
}

function toJsonObject(schema: object): AnyJsonObject {
  return JSON.parse(JSON.stringify(schema)) as AnyJsonObject;
}

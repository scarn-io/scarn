import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AnyJsonObject } from "../../../common/contracts/json";
import {
  createStdioMcpTransport,
  remoteMcpTransportCandidates,
  resolveLocalMcpLaunch,
  resolveRemoteMcpEndpoint,
} from "../../../common/infra/mcp-transport";
import type { McpToolLister } from "../application/list-mcp-server-tools";
import type { ListedMcpTool } from "../domain/agent-tools-manifest";
import type { DiscoveredMcpServer } from "../domain/discovered-agent-tools";

/**
 * {@link McpToolLister} over the official MCP SDK client.
 *
 * A `local` server is spawned with the merged env plus its own `environment`,
 * in its `cwd` resolved against `repoRoot` (default `repoRoot`), stderr
 * discarded. A `remote` server is tried over Streamable HTTP first and SSE
 * second, as OpenCode does. Every `{env:VAR}` is substituted from the merged
 * env before starting. The client is always closed, which for stdio
 * terminates the process (SIGTERM, then SIGKILL), on success, failure and
 * abort alike.
 */
export class SdkMcpToolLister implements McpToolLister {
  constructor(private readonly options: { repoRoot: string }) {}

  async listTools(input: {
    server: DiscoveredMcpServer;
    env: Readonly<Record<string, string>>;
    signal: AbortSignal;
  }): Promise<ListedMcpTool[]> {
    const { config } = input.server;

    if (config.type === "local") {
      const launch = resolveLocalMcpLaunch(config, input.env);
      const [command, ...args] = launch.command;
      return listOver(
        createStdioMcpTransport({
          command,
          args,
          env: { ...input.env, ...launch.environment },
          cwd: path.resolve(this.options.repoRoot, launch.cwd ?? "."),
          stderr: "ignore",
        }),
        input.signal,
      );
    }

    const [streamable, sse] = remoteMcpTransportCandidates(
      resolveRemoteMcpEndpoint(config, input.env),
    );
    try {
      return await listOver(streamable(), input.signal);
    } catch (streamableError) {
      if (input.signal.aborted) throw streamableError;
      try {
        return await listOver(sse(), input.signal);
      } catch {
        throw streamableError;
      }
    }
  }
}

async function listOver(
  transport: Transport,
  signal: AbortSignal,
): Promise<ListedMcpTool[]> {
  const client = new Client({
    name: "scarn-designer-preflight",
    version: "0",
  });
  const close = () => {
    void client.close().catch(() => undefined);
  };
  signal.addEventListener("abort", close, { once: true });
  try {
    signal.throwIfAborted();
    await client.connect(transport, { signal });
    const tools: ListedMcpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(
        cursor === undefined ? undefined : { cursor },
        { signal },
      );
      tools.push(...page.tools.map(toListedTool));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return tools;
  } finally {
    signal.removeEventListener("abort", close);
    await client.close().catch(() => undefined);
  }
}

function toListedTool(tool: Tool): ListedMcpTool {
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

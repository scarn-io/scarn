/**
 * A real MCP server for the `SdkMcpToolCaller` tests, served over stdio when
 * run directly (`bun run tool-call-mcp-server.ts`) or over Streamable HTTP
 * through {@link serveToolCallFixtureOverHttp}.
 *
 * Tools: `echo` (text), `structured` (structuredContent), `fails`
 * (`isError: true`), `sleep` (waits `ms`), `crash` (exits mid-call). An
 * unknown tool is a JSON-RPC `InvalidParams` "Tool … not found", as the SDK's
 * `McpServer` answers.
 *
 * Env knobs (stdio): `FIXTURE_PID_FILE` records the server's pid;
 * `FIXTURE_CALLS_FILE` gets one line per `tools/call`;
 * `FIXTURE_CRASH_ONCE_FILE` makes the first start exit 1 (and creates the
 * file); `FIXTURE_CRASH_ON_START` always exits 1.
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

export const FIXTURE_STRUCTURED_CONTENT = {
  pages: [{ id: "p1", title: "One" }],
};

export function createToolCallFixtureServer(hooks: {
  onCall?: (tool: string) => void;
}) {
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const server = new Server(
    { name: "scarn-tool-call-fixture", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: ["echo", "structured", "fails", "sleep", "crash"].map((name) => ({
      name,
      inputSchema: { type: "object" },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    hooks.onCall?.(name);
    switch (name) {
      case "echo":
        return {
          content: [{ type: "text", text: `echo: ${String(args?.["text"])}` }],
        };
      case "structured":
        return {
          content: [
            { type: "text", text: JSON.stringify(FIXTURE_STRUCTURED_CONTENT) },
          ],
          structuredContent: FIXTURE_STRUCTURED_CONTENT,
        };
      case "fails":
        return {
          content: [{ type: "text", text: "the tool failed" }],
          isError: true,
        };
      case "sleep":
        await new Promise((resolve) =>
          setTimeout(resolve, Number(args?.["ms"] ?? 60_000)),
        );
        return { content: [{ type: "text", text: "slept" }] };
      case "crash":
        return process.exit(3);
      default:
        throw new McpError(ErrorCode.InvalidParams, `Tool ${name} not found`);
    }
  });

  return server;
}

/**
 * A stateless Streamable HTTP endpoint at `/mcp`. `failFirstRequests` answers
 * the first N POSTs with 503 (a connection failure before `initialize`), and
 * `dropToolCalls` answers every `tools/call` with 500 after counting it (a
 * failure after the request went out).
 */
export function serveToolCallFixtureOverHttp(options: {
  failFirstRequests?: number;
  dropToolCalls?: boolean;
}) {
  const calls: string[] = [];
  let posts = 0;
  const httpServer = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/mcp") {
        return new Response("not found", { status: 404 });
      }
      if (request.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      posts += 1;
      if (posts <= (options.failFirstRequests ?? 0)) {
        return new Response("unavailable", { status: 503 });
      }
      if (options.dropToolCalls === true) {
        const body = (await request.clone().json()) as {
          method?: string;
          params?: { name?: string };
        };
        if (body.method === "tools/call") {
          calls.push(body.params?.name ?? "");
          return new Response("boom", { status: 500 });
        }
      }
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await createToolCallFixtureServer({
        onCall: (tool) => calls.push(tool),
      }).connect(transport);
      return transport.handleRequest(request);
    },
  });
  return {
    url: `http://127.0.0.1:${String(httpServer.port)}/mcp`,
    calls,
    stop: () => httpServer.stop(true),
  };
}

if (import.meta.main) {
  const env = process.env;
  if (env["FIXTURE_CRASH_ON_START"] === "1") process.exit(1);
  const crashOnce = env["FIXTURE_CRASH_ONCE_FILE"];
  if (crashOnce !== undefined && !existsSync(crashOnce)) {
    writeFileSync(crashOnce, "crashed\n");
    process.exit(1);
  }
  const pidFile = env["FIXTURE_PID_FILE"];
  if (pidFile !== undefined) writeFileSync(pidFile, String(process.pid));
  const callsFile = env["FIXTURE_CALLS_FILE"];
  await createToolCallFixtureServer({
    onCall: (tool) => {
      if (callsFile !== undefined) appendFileSync(callsFile, `${tool}\n`);
    },
  }).connect(new StdioServerTransport());
}

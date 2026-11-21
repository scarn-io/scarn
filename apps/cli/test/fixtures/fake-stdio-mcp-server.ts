/**
 * A dependency-free stdio MCP server for `scarn mcp pull` tests: newline-
 * delimited JSON-RPC that answers `initialize`, `ping` and `tools/list`. The
 * tools are read from the JSON file named by `FAKE_MCP_TOOLS_FILE` on every
 * `tools/list`, so a test can change them between pulls to simulate drift.
 *
 * Run directly: `bun run fake-stdio-mcp-server.ts`.
 */
import { readFileSync } from "node:fs";

type Request = {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: { protocolVersion?: string };
};

type Result = Record<string, object | string>;

function respond(id: number | string, result: Result): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function handle(request: Request): void {
  if (request.id === undefined) return;
  switch (request.method) {
    case "initialize": {
      respond(request.id, {
        protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "scarn-fake-stdio-mcp", version: "0.0.0" },
      });
      return;
    }
    case "tools/list": {
      const file = process.env["FAKE_MCP_TOOLS_FILE"] ?? "";
      const tools = JSON.parse(readFileSync(file, "utf8")) as object[];
      respond(request.id, { tools });
      return;
    }
    default:
      respond(request.id, {});
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line !== "") handle(JSON.parse(line) as Request);
    newline = buffer.indexOf("\n");
  }
});

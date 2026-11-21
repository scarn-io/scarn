/**
 * A stdio MCP server whose one tool declares a `title` and an `outputSchema`,
 * so the lister test can check both survive `tools/list` verbatim.
 *
 * Run directly: `bun run structured-output-mcp-server.ts`.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export const STRUCTURED_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    pages: { type: "array", items: { $ref: "#/$defs/page" } },
  },
  required: ["pages"],
  $defs: {
    page: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: ["string", "null"] },
      },
      required: ["id"],
    },
  },
};

// eslint-disable-next-line @typescript-eslint/no-deprecated
const server = new Server(
  { name: "scarn-structured-output-fixture", version: "0.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: "search_pages",
      title: "Search pages",
      description: "Finds pages by query.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      outputSchema: STRUCTURED_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true },
    },
  ],
}));

if (import.meta.main) {
  await server.connect(new StdioServerTransport());
}

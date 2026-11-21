import { join } from "node:path";
import type { DiscoveredMcpServer } from "@scarn/worker";
import type { ImportedMcpHandle } from "../src/lib/mcp-pull";

/**
 * Fixtures for the `scarn mcp pull` tests: tools for the fake stdio MCP
 * server, the server as the repo's MCP config would define it, and an
 * imported `defineMcp` handle pointing at the same server.
 */

export const FAKE_SERVER = join(
  import.meta.dir,
  "fixtures",
  "fake-stdio-mcp-server.ts",
);

export const SEARCH_TOOL = {
  name: "search_pages",
  title: "Search pages",
  description: "Finds pages by query.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
  outputSchema: {
    type: "object",
    properties: { ids: { type: "array", items: { type: "string" } } },
    required: ["ids"],
  },
};

export const CREATE_TOOL = {
  name: "create_page",
  inputSchema: {
    type: "object",
    properties: { title: { type: "string" } },
  },
};

export function stdioServer(name = "docs"): DiscoveredMcpServer {
  return {
    name,
    source: ".mcp.json",
    transport: "local",
    config: {
      type: "local",
      command: ["bun", "run", FAKE_SERVER],
      environment: {
        FAKE_MCP_TOOLS_FILE: "{env:FAKE_TOOLS}",
        API_KEY: "{env:DOCS_API_KEY}",
      },
    },
    requiredEnv: ["DOCS_API_KEY", "FAKE_TOOLS"],
    inlineSecrets: [],
    shadowed: [],
  };
}

export function handle(
  overrides: Partial<ImportedMcpHandle> = {},
): ImportedMcpHandle {
  return {
    file: "mcps.ts",
    exportName: "docs",
    name: "docs",
    connection: {
      type: "local",
      command: ["bun", "run", FAKE_SERVER],
      environment: { FAKE_MCP_TOOLS_FILE: "{env:FAKE_TOOLS}" },
    },
    catalogServer: null,
    ...overrides,
  };
}

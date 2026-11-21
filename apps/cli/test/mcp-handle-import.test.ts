import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { importMcpHandlesViaSubprocess } from "../src/lib/mcp-handle-import";
import { MCP_HANDLES_SCRIPT_FILENAME } from "../src/templates/mcp-handles-script";

/**
 * Runs the real handle-import script with bun. The builder directory lives
 * under `apps/cli` so `@scarn/sdk` resolves from the workspace's
 * `node_modules`, as it does from a user's installed builder directory.
 */

let builderDir: string;

beforeEach(() => {
  builderDir = mkdtempSync(join(import.meta.dir, ".tmp-mcp-handles-"));
  writeFileSync(join(builderDir, "bun.lock"), "");
  writeFileSync(
    join(builderDir, "mcps.ts"),
    `import { defineMcp, mcpTool, mcpToolCatalog, z } from "@scarn/sdk/definitions/steps";

const docsTools = mcpToolCatalog({
  source: { server: "docs" },
  tools: { search: mcpTool({ name: "search", input: z.object({ q: z.string() }) }) },
});

export const docs = defineMcp({
  type: "remote",
  name: "docs-prod",
  url: "https://docs.example.com/mcp",
  headers: { Authorization: "Bearer {env:DOCS_TOKEN}" },
  oauth: { client_id: "abc", client_secret: "{env:DOCS_SECRET}" },
}).withTools(docsTools);

export const local = defineMcp({
  type: "local",
  name: "local-docs",
  command: ["node", "server.js"],
  environment: { KEY: "{env:LOCAL_KEY}" },
});

export const notAHandle = { name: "x" };
`,
  );
  writeFileSync(join(builderDir, "broken.ts"), "throw new Error('boom');\n");
});

afterEach(() => {
  rmSync(builderDir, { recursive: true, force: true });
});

describe("importMcpHandlesViaSubprocess", () => {
  test("reads every handle's connection and catalog server, never oauth", async () => {
    const imported = await importMcpHandlesViaSubprocess({ builderDir });

    expect(imported.handles).toEqual([
      {
        file: "mcps.ts",
        exportName: "docs",
        name: "docs-prod",
        connection: {
          type: "remote",
          url: "https://docs.example.com/mcp",
          headers: { Authorization: "Bearer {env:DOCS_TOKEN}" },
        },
        catalogServer: "docs",
      },
      {
        file: "mcps.ts",
        exportName: "local",
        name: "local-docs",
        connection: {
          type: "local",
          command: ["node", "server.js"],
          environment: { KEY: "{env:LOCAL_KEY}" },
        },
        catalogServer: null,
      },
    ]);
    expect(imported.errors).toEqual([{ file: "broken.ts", message: "boom" }]);
    expect(JSON.stringify(imported)).not.toContain("client_secret");
    expect(existsSync(join(builderDir, MCP_HANDLES_SCRIPT_FILENAME))).toBe(
      false,
    );
  });

  test("reads one export of one file", async () => {
    const imported = await importMcpHandlesViaSubprocess({
      builderDir,
      request: { file: "mcps.ts", exportName: "local" },
    });
    expect(imported.handles.map((handle) => handle.exportName)).toEqual([
      "local",
    ]);
  });
});

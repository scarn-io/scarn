import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMcpToolLock } from "@scarn/sdk/mcp-tools/codegen";
import { SdkMcpToolLister, type DiscoveredMcpServer } from "@scarn/worker";
import { CliError } from "../src/lib/cli-error";
import {
  parseHandleSpecifier,
  runMcpPull,
  type McpPullPorts,
  type McpPullSelection,
} from "../src/lib/mcp-pull";
import { connection, notionServer } from "./design-managed-connections-fakes";
import {
  CREATE_TOOL,
  handle,
  SEARCH_TOOL,
  stdioServer,
} from "./mcp-pull-fakes";
import { createReporterRecorder } from "./utils";

const SECRET = "sk-live-super-secret-value";
const LISTED_AT = new Date("2026-11-19T10:00:00.000Z");

let root: string;
let builderDir: string;
let toolsFile: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "scarn-mcp-pull-"));
  builderDir = join(root, ".scarn", "pipeline-builder");
  mkdirSync(builderDir, { recursive: true });
  toolsFile = join(root, "tools.json");
  setTools([SEARCH_TOOL]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function setTools(tools: readonly object[]): void {
  writeFileSync(toolsFile, JSON.stringify(tools));
}

function ports(overrides: Partial<McpPullPorts> = {}): McpPullPorts {
  return {
    discoverServers: () => Promise.resolve([stdioServer()]),
    readToolEnv: () =>
      Promise.resolve({ FAKE_TOOLS: toolsFile, DOCS_API_KEY: SECRET }),
    mcpToolLister: new SdkMcpToolLister({ repoRoot: root }),
    importHandles: () => Promise.resolve({ handles: [], errors: [] }),
    resolveProject: () =>
      Promise.resolve({
        baseUrl: "https://scarn.test",
        projectId: "project-1",
      }),
    listManagedConnections: () =>
      Promise.resolve({ ok: true, connections: [] }),
    listManagedConnectionTools: () =>
      Promise.reject(new Error("no connection to list")),
    ...overrides,
  };
}

async function pull(input: {
  selection?: McpPullSelection;
  check?: boolean;
  ports?: McpPullPorts;
}) {
  const recorder = createReporterRecorder();
  try {
    const result = await runMcpPull({
      builderDir,
      selection: input.selection,
      check: input.check ?? false,
      reporter: recorder.reporter,
      ports: input.ports ?? ports(),
      now: () => LISTED_AT,
      timeoutMs: 10_000,
    });
    return { result, error: undefined, recorder };
  } catch (error) {
    return { result: undefined, error: error as CliError, recorder };
  }
}

function mcpDir(): string {
  return join(builderDir, "mcp");
}

function readMcpFile(file: string): string {
  return readFileSync(join(mcpDir(), file), "utf8");
}

function allOutput(recorder: ReturnType<typeof createReporterRecorder>) {
  return [...recorder.calls, ...recorder.tasks]
    .map((call) => call.message)
    .join("\n");
}

describe("scarn mcp pull <server> against a stdio server", () => {
  test("writes the lock and the generated catalog, with no secrets", async () => {
    const { error, result, recorder } = await pull({
      selection: { kind: "server", server: "docs" },
    });

    expect(error).toBeUndefined();
    expect(result?.pulled).toEqual(["docs"]);
    expect(readdirSync(mcpDir()).sort()).toEqual([
      "docs.lock.json",
      "docs.tools.ts",
    ]);
    const lock = parseMcpToolLock(readMcpFile("docs.lock.json"));
    expect(lock.server).toBe("docs");
    expect(lock.listedAt).toBe(LISTED_AT.toISOString());
    expect(lock.tools).toEqual([SEARCH_TOOL]);
    const catalog = readMcpFile("docs.tools.ts");
    expect(catalog).toContain("export const docsTools = mcpToolCatalog(");
    expect(catalog).toContain(lock.hash);

    for (const text of [
      readMcpFile("docs.lock.json"),
      catalog,
      allOutput(recorder),
    ]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(toolsFile);
    }
  });

  test("re-pulling an unchanged server keeps the lock's listedAt", async () => {
    await pull({ selection: { kind: "server", server: "docs" } });
    const first = readMcpFile("docs.lock.json");
    const recorder = createReporterRecorder();
    await runMcpPull({
      builderDir,
      selection: { kind: "server", server: "docs" },
      check: false,
      reporter: recorder.reporter,
      ports: ports(),
      now: () => new Date("2027-01-01T00:00:00.000Z"),
    });
    expect(readMcpFile("docs.lock.json")).toBe(first);
    expect(allOutput(recorder)).toContain("unchanged");
  });

  test("an unknown server fails and lists the known ones", async () => {
    const { error } = await pull({
      selection: { kind: "server", server: "nope" },
      ports: ports({
        importHandles: () =>
          Promise.resolve({
            handles: [handle({ name: "linear" })],
            errors: [],
          }),
      }),
    });
    expect(error).toBeInstanceOf(CliError);
    expect(error?.code).toBe("mcp_server_not_found");
    expect(error?.message).toContain("Known servers: docs, linear.");
    expect(existsSync(mcpDir())).toBe(false);
  });

  test("a missing required env var fails without writing files", async () => {
    const { error } = await pull({
      selection: { kind: "server", server: "docs" },
      ports: ports({
        readToolEnv: () => Promise.resolve({ FAKE_TOOLS: toolsFile }),
      }),
    });
    expect(error?.code).toBe("mcp_pull_failed");
    expect(error?.message).toContain("missing DOCS_API_KEY");
    expect(existsSync(mcpDir())).toBe(false);
  });

  test("a server that fails to start fails without writing files", async () => {
    const broken: DiscoveredMcpServer = {
      ...stdioServer(),
      config: { type: "local", command: ["scarn-no-such-binary-xyz"] },
      requiredEnv: [],
    };
    const { error } = await pull({
      selection: { kind: "server", server: "docs" },
      ports: ports({ discoverServers: () => Promise.resolve([broken]) }),
    });
    expect(error?.code).toBe("mcp_pull_failed");
    expect(error?.message).toContain("docs: failed:");
    expect(existsSync(mcpDir())).toBe(false);
  });
});

describe("scarn mcp pull --handle", () => {
  test("parses <file>#<export>", () => {
    expect(parseHandleSpecifier("mcps.ts#notion")).toEqual({
      file: "mcps.ts",
      exportName: "notion",
    });
    expect(parseHandleSpecifier("mcps.ts")).toEqual({
      file: "mcps.ts",
      exportName: undefined,
    });
    expect(() => parseHandleSpecifier("mcps.ts#")).toThrow(CliError);
  });

  test("lists an inline local handle under the handle's name", async () => {
    writeFileSync(join(builderDir, "mcps.ts"), "");
    const requests: unknown[] = [];
    const { error, result } = await pull({
      selection: { kind: "handle", file: "mcps.ts", exportName: "local" },
      ports: ports({
        discoverServers: () => Promise.resolve([]),
        importHandles: (request) => {
          requests.push(request);
          return Promise.resolve({
            handles: [handle({ name: "inline-docs", exportName: "local" })],
            errors: [],
          });
        },
      }),
    });
    expect(error).toBeUndefined();
    expect(requests).toEqual([{ file: "mcps.ts", exportName: "local" }]);
    expect(result?.pulled).toEqual(["inline-docs"]);
    expect(
      parseMcpToolLock(readMcpFile("inline-docs.lock.json")).tools,
    ).toEqual([SEARCH_TOOL]);
  });

  test("a handle with a managed connection is listed through the API", async () => {
    writeFileSync(join(builderDir, "mcps.ts"), "");
    const toolCalls: string[] = [];
    const { error } = await pull({
      selection: { kind: "handle", file: "mcps.ts", exportName: "notion" },
      ports: ports({
        mcpToolLister: {
          listTools: () => Promise.reject(new Error("must not connect")),
        },
        importHandles: () =>
          Promise.resolve({
            handles: [
              handle({
                name: "notion",
                exportName: "notion",
                connection: {
                  type: "remote",
                  url: "https://mcp.notion.com/mcp",
                  auth: { connection: "notion" },
                },
              }),
            ],
            errors: [],
          }),
        listManagedConnections: () =>
          Promise.resolve({ ok: true, connections: [connection()] }),
        listManagedConnectionTools: ({ connectionId }) => {
          toolCalls.push(connectionId);
          return Promise.resolve({ ok: true, tools: [CREATE_TOOL] });
        },
      }),
    });
    expect(error).toBeUndefined();
    expect(toolCalls).toEqual(["conn-1"]);
    expect(parseMcpToolLock(readMcpFile("notion.lock.json")).tools).toEqual([
      CREATE_TOOL,
    ]);
  });
});

describe("scarn mcp pull <server> for a managed connection", () => {
  test("a repo server at a connection's resource never starts locally", async () => {
    const { error } = await pull({
      selection: { kind: "server", server: "notion" },
      ports: ports({
        discoverServers: () => Promise.resolve([notionServer()]),
        mcpToolLister: {
          listTools: () => Promise.reject(new Error("must not connect")),
        },
        listManagedConnections: () =>
          Promise.resolve({
            ok: true,
            connections: [connection({ state: "reconnect_required" })],
          }),
      }),
    });
    expect(error?.code).toBe("mcp_pull_failed");
    expect(error?.message).toContain("the connection is reconnect_required");
    expect(existsSync(mcpDir())).toBe(false);
  });
});

describe("scarn mcp pull --all", () => {
  test("with no locks, says so and succeeds", async () => {
    const { error, result, recorder } = await pull({
      selection: { kind: "all" },
    });
    expect(error).toBeUndefined();
    expect(result?.pulled).toEqual([]);
    expect(allOutput(recorder)).toContain("No MCP tool locks");
  });

  test("re-pulls every locked server", async () => {
    await pull({ selection: { kind: "server", server: "docs" } });
    setTools([SEARCH_TOOL, CREATE_TOOL]);
    const { error, result } = await pull({ selection: { kind: "all" } });
    expect(error).toBeUndefined();
    expect(result?.pulled).toEqual(["docs"]);
    expect(
      parseMcpToolLock(readMcpFile("docs.lock.json")).tools.map(
        (tool) => tool.name,
      ),
    ).toEqual(["create_page", "search_pages"]);
  });
});

describe("scarn mcp pull --check", () => {
  test("passes when the live tools match the lock", async () => {
    await pull({ selection: { kind: "server", server: "docs" } });
    const { error, result } = await pull({ check: true });
    expect(error).toBeUndefined();
    expect(result?.pulled).toEqual(["docs"]);
  });

  test("fails on drift, names the server and writes nothing", async () => {
    await pull({ selection: { kind: "server", server: "docs" } });
    const lockBefore = readMcpFile("docs.lock.json");
    const catalogBefore = readMcpFile("docs.tools.ts");
    setTools([{ ...SEARCH_TOOL, description: "Changed." }, CREATE_TOOL]);

    const { error, recorder } = await pull({ check: true });

    expect(error?.code).toBe("mcp_tools_drift");
    expect(error?.message).toContain("docs");
    expect(allOutput(recorder)).toContain(
      "added create_page; changed search_pages",
    );
    expect(readMcpFile("docs.lock.json")).toBe(lockBefore);
    expect(readMcpFile("docs.tools.ts")).toBe(catalogBefore);
  });

  test("fails when a locked server can't be listed", async () => {
    await pull({ selection: { kind: "server", server: "docs" } });
    const { error } = await pull({
      check: true,
      ports: ports({
        readToolEnv: () => Promise.resolve({ FAKE_TOOLS: toolsFile }),
      }),
    });
    expect(error?.code).toBe("mcp_pull_failed");
    expect(error?.message).toContain("missing DOCS_API_KEY");
  });

  test("warns when a handle's name differs from its catalog's server", async () => {
    await pull({ selection: { kind: "server", server: "docs" } });
    const { error, recorder } = await pull({
      check: true,
      ports: ports({
        importHandles: () =>
          Promise.resolve({
            handles: [
              handle({
                exportName: "prodDocs",
                name: "docs-prod",
                catalogServer: "docs",
              }),
              handle({ catalogServer: "docs" }),
            ],
            errors: [],
          }),
      }),
    });
    expect(error).toBeUndefined();
    const warnings = recorder.calls.filter((call) => call.method === "warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain(
      'mcps.ts#prodDocs: the handle "docs-prod" uses the catalog pulled from "docs"',
    );
  });
});

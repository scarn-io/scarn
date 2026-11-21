import { describe, expect, test } from "bun:test";
import {
  buildMcpToolLock,
  type ListedMcpToolInput,
} from "@scarn/sdk/mcp-tools/codegen";
import type {
  AgentToolsManifest,
  DiscoveredAgentTools,
  DiscoveredMcpServer,
} from "@scarn/worker";
import {
  announceMcpToolListing,
  ensureAgentToolsManifest,
} from "../src/lib/design-agent-tools";
import type { LockedServer } from "../src/lib/mcp-pull-context";
import {
  EMPTY_DISCOVERY,
  FAKE_AGENT_TOOLS_MANIFEST_PATH,
  fakeAgentToolsPorts,
} from "./design-agent-tools-fakes";
import { createReporterRecorder } from "./utils";

function server(name: string, requiredEnv: string[] = []): DiscoveredMcpServer {
  return {
    name,
    source: ".mcp.json",
    transport: "local",
    config: { type: "local", command: ["run", name] },
    requiredEnv,
    inlineSecrets: [],
    shadowed: [],
  };
}

function locked(name: string, tools: ListedMcpToolInput[]): LockedServer {
  return {
    ok: true,
    file: `${name}.lock.json`,
    lock: buildMcpToolLock({
      server: name,
      listedAt: "2026-11-01T00:00:00Z",
      tools,
    }),
  };
}

const DISCOVERY: DiscoveredAgentTools = {
  ...EMPTY_DISCOVERY,
  servers: [server("postgres"), server("sentry", ["SENTRY_TOKEN"])],
  skills: [
    {
      name: "triage",
      description: "Triage a ticket",
      path: ".claude/skills/triage/SKILL.md",
      shadowed: [],
    },
  ],
};

async function run(
  overrides: Parameters<typeof fakeAgentToolsPorts>[0] = {},
): Promise<{
  result: string | null;
  written: AgentToolsManifest[];
  recorder: ReturnType<typeof createReporterRecorder>;
}> {
  const written: AgentToolsManifest[] = [];
  const recorder = createReporterRecorder();
  const result = await ensureAgentToolsManifest({
    baseUrl: "https://scarn.test",
    projectId: "project-1",
    project: "acme/app",
    owner: "acme",
    slug: "app",
    reporter: recorder.reporter,
    now: () => new Date("2026-10-14T00:00:00Z"),
    ports: fakeAgentToolsPorts({
      writeAgentToolsManifest: ({ manifest }) => {
        written.push(manifest);
        return Promise.resolve(FAKE_AGENT_TOOLS_MANIFEST_PATH);
      },
      ...overrides,
    }),
  });
  return { result, written, recorder };
}

describe("announceMcpToolListing", () => {
  test("is count-accurate", () => {
    expect(announceMcpToolListing(1)).toBe(
      "Starting 1 MCP server from your repo to list its tools…",
    );
    expect(announceMcpToolListing(4)).toBe(
      "Starting 4 MCP servers from your repo to list their tools…",
    );
  });
});

describe("ensureAgentToolsManifest", () => {
  test("announces only the servers it will start, and records the rest as unavailable", async () => {
    const { result, written, recorder } = await run({
      discoverAgentTools: () => Promise.resolve(DISCOVERY),
      mcpToolLister: {
        listTools: () =>
          Promise.resolve([{ name: "query", inputSchema: { type: "object" } }]),
      },
    });

    expect(result).toBe(FAKE_AGENT_TOOLS_MANIFEST_PATH);
    expect(recorder.tasks[0]).toEqual({
      method: "startActivity",
      message: "Starting 1 MCP server from your repo to list its tools…",
    });
    const [manifest] = written;
    expect(manifest?.servers.map((s) => [s.name, s.availability])).toEqual([
      ["postgres", { status: "available" }],
      ["sentry", { status: "unavailable", reason: "missing SENTRY_TOKEN" }],
    ]);
    expect(manifest?.skills).toEqual([
      {
        name: "triage",
        description: "Triage a ticket",
        path: ".claude/skills/triage/SKILL.md",
      },
    ]);
  });

  test("starts nothing and announces nothing when the repo defines no servers", async () => {
    const { result, recorder } = await run();

    expect(result).toBe(FAKE_AGENT_TOOLS_MANIFEST_PATH);
    expect(recorder.tasks).toEqual([]);
  });

  test("never writes an env value into the manifest", async () => {
    const { written } = await run({
      discoverAgentTools: () =>
        Promise.resolve({
          ...EMPTY_DISCOVERY,
          servers: [server("sentry", ["SENTRY_TOKEN"])],
        }),
      readToolEnv: () => Promise.resolve({ SENTRY_TOKEN: "sk-live-secret" }),
      mcpToolLister: {
        listTools: () =>
          Promise.reject(new Error("401 for token sk-live-secret")),
      },
    });

    expect(JSON.stringify(written)).not.toContain("sk-live-secret");
    expect(written[0]?.servers[0]?.availability).toEqual({
      status: "failed",
      reason: "401 for token {env:SENTRY_TOKEN}",
    });
  });

  test("marks the servers `scarn mcp pull` has locked, and only those", async () => {
    const query = { name: "query", inputSchema: { type: "object" } };
    const { written } = await run({
      discoverAgentTools: () =>
        Promise.resolve({
          ...EMPTY_DISCOVERY,
          servers: [server("postgres"), server("sentry"), server("github")],
        }),
      mcpToolLister: { listTools: () => Promise.resolve([query]) },
      readMcpToolLocks: () =>
        Promise.resolve([
          locked("postgres", [query]),
          locked("sentry", [
            { name: "issues", inputSchema: { type: "object" } },
          ]),
          locked("notion", [query]),
          { ok: false, file: "broken.lock.json", reason: "not valid JSON" },
        ]),
    });

    const [manifest] = written;
    const byName = new Map(manifest?.servers.map((s) => [s.name, s.lock]));
    expect(byName.get("postgres")).toMatchObject({
      status: "locked",
      file: "mcp/postgres.lock.json",
      catalogFile: "mcp/postgres.tools.ts",
      toolNames: ["query"],
      drift: "matches",
    });
    expect(byName.get("sentry")).toMatchObject({ drift: "drifted" });
    expect(byName.get("github")).toBeUndefined();
    expect(
      manifest?.locks?.map((lock) =>
        lock.status === "locked" ? lock.server : lock.file,
      ),
    ).toEqual(["postgres", "sentry", "notion", "mcp/broken.lock.json"]);
    expect(manifest?.locks?.[2]).toMatchObject({ drift: "unknown" });
  });

  test("a lock the preflight could not list against has unknown drift", async () => {
    const { written } = await run({
      discoverAgentTools: () =>
        Promise.resolve({
          ...EMPTY_DISCOVERY,
          servers: [server("sentry", ["SENTRY_TOKEN"])],
        }),
      readMcpToolLocks: () => Promise.resolve([locked("sentry", [])]),
    });

    expect(written[0]?.servers[0]?.lock).toMatchObject({
      status: "locked",
      drift: "unknown",
    });
  });

  test("warns about a drifted or unreadable lock, and still writes the manifest", async () => {
    const { result, recorder } = await run({
      discoverAgentTools: () =>
        Promise.resolve({ ...EMPTY_DISCOVERY, servers: [server("postgres")] }),
      mcpToolLister: { listTools: () => Promise.resolve([]) },
      readMcpToolLocks: () =>
        Promise.resolve([
          locked("postgres", [{ name: "query", inputSchema: {} }]),
          { ok: false, file: "broken.lock.json", reason: "not valid JSON" },
        ]),
    });

    expect(result).toBe(FAKE_AGENT_TOOLS_MANIFEST_PATH);
    expect(recorder.calls).toContainEqual({
      method: "warn",
      message:
        "MCP server postgres's tools changed since mcp/postgres.lock.json; run `scarn mcp pull postgres` to update it.",
    });
    expect(recorder.calls).toContainEqual({
      method: "warn",
      message: "MCP tool lock mcp/broken.lock.json: not valid JSON",
    });
  });

  test("leaves locks out when they cannot be read", async () => {
    const { result, written } = await run({
      readMcpToolLocks: () => Promise.reject(new Error("EACCES")),
    });

    expect(result).toBe(FAKE_AGENT_TOOLS_MANIFEST_PATH);
    expect(written[0]?.locks).toBeUndefined();
  });

  test("a failure is reported, never fatal", async () => {
    const { result, recorder } = await run({
      discoverAgentTools: () => Promise.reject(new Error("disk on fire")),
    });

    expect(result).toBeNull();
    expect(recorder.calls).toContainEqual({
      method: "warn",
      message:
        "Could not record this repository's MCP servers and skills for the designer: disk on fire",
    });
  });
});

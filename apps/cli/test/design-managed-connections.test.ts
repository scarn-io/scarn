import { describe, expect, test } from "bun:test";
import type { DiscoveredMcpServer } from "@scarn/worker";
import {
  connection,
  NOTION_URL,
  notionServer,
  runWithConnections,
  SEARCH_TOOL,
} from "./design-managed-connections-fakes";

const LOCAL_SERVER: DiscoveredMcpServer = {
  name: "postgres",
  source: ".mcp.json",
  transport: "local",
  config: { type: "local", command: ["pg-mcp"] },
  requiredEnv: [],
  inlineSecrets: [],
  shadowed: [],
};

describe("ensureAgentToolsManifest with managed connections", () => {
  test("a repository Notion server with a ready connection is listed through the API, never started locally", async () => {
    const localStarts: string[] = [];
    const { manifest, toolCalls } = await runWithConnections({
      servers: [notionServer(), LOCAL_SERVER],
      localStarts,
    });

    expect(localStarts).toEqual(["postgres"]);
    expect(toolCalls).toBe(1);
    expect(manifest?.version).toBe(2);
    expect(manifest?.servers[0]).toMatchObject({
      name: "notion",
      connection: {
        name: "notion",
        label: "Notion",
        state: "ready",
        reasonCode: null,
      },
      availability: { status: "available" },
      tools: [SEARCH_TOOL],
    });
    expect(manifest?.servers[1]?.connection).toBeUndefined();
  });

  test("ready_with_pending_reconnect still lists tools", async () => {
    const { manifest } = await runWithConnections({
      connections: [connection({ state: "ready_with_pending_reconnect" })],
    });

    expect(manifest?.servers[0]?.availability).toEqual({
      status: "available",
    });
  });

  test("reconnect_required is unavailable with its reason, and the tools route is not called", async () => {
    const localStarts: string[] = [];
    const { manifest, toolCalls, result } = await runWithConnections({
      connections: [
        connection({
          state: "reconnect_required",
          reasonCode: "refresh_failed",
        }),
      ],
      localStarts,
    });

    expect(result).not.toBeNull();
    expect(toolCalls).toBe(0);
    expect(localStarts).toEqual([]);
    expect(manifest?.servers[0]).toMatchObject({
      connection: {
        name: "notion",
        label: "Notion",
        state: "reconnect_required",
        reasonCode: "refresh_failed",
      },
      availability: {
        status: "unavailable",
        reason: "the connection is reconnect_required (refresh_failed)",
      },
      tools: [],
    });
  });

  test("403 means the user can't list the connection's tools", async () => {
    const { manifest } = await runWithConnections({
      tools: [{ ok: false, status: 403 }],
    });

    expect(manifest?.servers[0]?.availability).toEqual({
      status: "unavailable",
      reason: "you can't list this connection's tools",
    });
  });

  test("409 is unavailable with the state and reason code it carries", async () => {
    const { manifest } = await runWithConnections({
      tools: [
        {
          ok: false,
          status: 409,
          state: "reconnect_required",
          reasonCode: "grant_expired",
        },
      ],
    });

    expect(manifest?.servers[0]?.availability).toEqual({
      status: "unavailable",
      reason: "the connection is reconnect_required (grant_expired)",
    });
  });

  test("502 is failed, never fatal", async () => {
    const { manifest, result } = await runWithConnections({
      tools: [{ ok: false, status: 502 }],
    });

    expect(result).not.toBeNull();
    expect(manifest?.servers[0]?.availability).toEqual({
      status: "failed",
      reason: "couldn't list the connection's tools (HTTP 502)",
    });
  });

  test("a busy 503 is retried once after Retry-After", async () => {
    const { manifest, toolCalls } = await runWithConnections({
      tools: [
        { ok: false, status: 503, retryAfterSeconds: 0 },
        { ok: true, tools: [SEARCH_TOOL] },
      ],
    });

    expect(toolCalls).toBe(2);
    expect(manifest?.servers[0]?.availability).toEqual({
      status: "available",
    });
  });

  test("a 503 twice is failed", async () => {
    const { manifest, toolCalls } = await runWithConnections({
      tools: [{ ok: false, status: 503, retryAfterSeconds: 0 }],
    });

    expect(toolCalls).toBe(2);
    expect(manifest?.servers[0]?.availability.status).toBe("failed");
  });

  test("a disconnected connection is unavailable under its label, not started locally", async () => {
    const localStarts: string[] = [];
    const { manifest, toolCalls } = await runWithConnections({
      connections: [connection({ state: "disconnected", account: null })],
      localStarts,
    });

    expect(localStarts).toEqual([]);
    expect(toolCalls).toBe(0);
    expect(manifest?.servers[0]).toMatchObject({
      connection: { name: "notion", state: "disconnected" },
      availability: {
        status: "unavailable",
        reason: "the project isn't connected to Notion",
      },
    });
  });

  test("a server is matched to any listed connection by its resource, whatever its name", async () => {
    const localStarts: string[] = [];
    const docsUrl = "https://docs.acme.test/mcp";
    const { manifest } = await runWithConnections({
      servers: [
        {
          ...notionServer("docs"),
          config: { type: "remote", url: "HTTPS://docs.acme.test/mcp/" },
        },
      ],
      connections: [
        connection({
          name: "acme-docs",
          label: "Acme Docs",
          preset: null,
          resource: docsUrl,
        }),
      ],
      localStarts,
    });

    expect(localStarts).toEqual([]);
    expect(manifest?.servers[0]).toMatchObject({
      name: "docs",
      connection: { name: "acme-docs", label: "Acme Docs", state: "ready" },
      availability: { status: "available" },
    });
  });

  test("no connection for the server's URL: the server is an ordinary repository server", async () => {
    const localStarts: string[] = [];
    const { manifest } = await runWithConnections({
      connections: [],
      localStarts,
    });

    expect(localStarts).toEqual(["notion"]);
    expect(manifest?.connections).toEqual([]);
    expect(manifest?.servers[0]?.connection).toBeUndefined();
  });

  test("a failed list call continues without connections", async () => {
    const localStarts: string[] = [];
    const { manifest, result, recorder } = await runWithConnections({
      list: () => Promise.resolve({ ok: false, status: 403 }),
      localStarts,
    });

    expect(result).not.toBeNull();
    expect(localStarts).toEqual(["notion"]);
    expect(manifest?.connections).toBeUndefined();
    expect(manifest?.servers[0]?.connection).toBeUndefined();
    expect(recorder.calls).toContainEqual({
      method: "warn",
      message:
        "Could not check this project's MCP connections: couldn't list the project's connections (HTTP 403)",
    });
  });

  test("a list call that throws is treated like any other failure", async () => {
    const { manifest, result, recorder } = await runWithConnections({
      list: () => Promise.reject(new Error("ECONNREFUSED")),
    });

    expect(result).not.toBeNull();
    expect(manifest?.connections).toBeUndefined();
    expect(recorder.calls).toContainEqual({
      method: "warn",
      message:
        "Could not check this project's MCP connections: couldn't list the project's connections (no response)",
    });
  });

  test("with no repository server, `connections` lists a ready connection's tools", async () => {
    const { manifest } = await runWithConnections({ servers: [] });

    expect(manifest?.servers).toEqual([]);
    expect(manifest?.connections).toEqual([
      {
        name: "notion",
        label: "Notion",
        url: NOTION_URL,
        state: "ready",
        reasonCode: null,
        account: { userName: "Dana", workspaceName: "Acme" },
        availability: { status: "available" },
        tools: [SEARCH_TOOL],
      },
    ]);
  });
});

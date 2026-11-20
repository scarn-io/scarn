import { describe, expect, test } from "bun:test";
import type { ManagedConnectionSummary } from "../src/lib/design-managed-connections";
import { CliError } from "../src/lib/cli-error";
import {
  assertNoPushConnectionProblems,
  pushConnectionReport,
  type PushConnectionStatusPorts,
} from "../src/lib/push-connection-status";
import type { PushedMcpServerUrl } from "../src/lib/push-mcp-server-urls";

const NOTION_URL = "https://mcp.notion.com/mcp";

const connection = (
  overrides: Partial<ManagedConnectionSummary>,
): ManagedConnectionSummary => ({
  id: "conn-1",
  projectId: "proj-1",
  name: "notion",
  label: "Notion",
  preset: "notion",
  resource: NOTION_URL,
  state: "ready",
  reasonCode: null,
  generation: 1,
  version: 1,
  connectedBy: null,
  account: {
    userName: "Ada",
    workspaceName: "Acme",
    identityVerified: true,
  },
  grantedScopes: [],
  reconnectBy: null,
  candidate: null,
  lastRevocation: null,
  createdAt: "2026-11-18T00:00:00.000Z",
  updatedAt: "2026-11-18T00:00:00.000Z",
  ...overrides,
});

const server = (
  overrides: Partial<PushedMcpServerUrl> = {},
): PushedMcpServerUrl => ({
  step: "read",
  key: "docs",
  connection: "notion",
  url: NOTION_URL,
  ...overrides,
});

function listing(connections: ManagedConnectionSummary[]): {
  ports: PushConnectionStatusPorts;
  calls: () => number;
} {
  let calls = 0;
  return {
    ports: {
      listManagedConnections: () => {
        calls += 1;
        return Promise.resolve({ ok: true, connections });
      },
    },
    calls: () => calls,
  };
}

const report = (
  ports: PushConnectionStatusPorts,
  servers: PushedMcpServerUrl[] = [server()],
) =>
  pushConnectionReport({
    baseUrl: "https://scarn.test",
    projectId: "proj-1",
    servers,
    ports,
  });

const status = async (
  ports: PushConnectionStatusPorts,
  servers?: PushedMcpServerUrl[],
) => (await report(ports, servers)).status;

describe("pushConnectionReport status lines", () => {
  test("a ready connection prints its account display names", async () => {
    const { ports, calls } = listing([connection({})]);
    expect(await status(ports)).toEqual([
      'Notion ("notion"): connected as Ada / Acme',
    ]);
    expect(calls()).toBe(1);
  });

  test("one line per connection, however many servers use it", async () => {
    const { ports } = listing([connection({})]);
    expect(
      await status(ports, [server(), server({ step: "write", key: "notes" })]),
    ).toHaveLength(1);
  });

  test("a pending reconnect is still connected, with a note", async () => {
    const { ports } = listing([
      connection({ state: "ready_with_pending_reconnect" }),
    ]);
    const [line] = await status(ports);
    expect(line).toStartWith('Notion ("notion"): connected as Ada / Acme');
    expect(line).toContain("reconnect is pending");
  });

  test("no connection prints not connected", async () => {
    const { ports } = listing([]);
    expect(await status(ports)).toEqual([
      "notion: not connected — a project admin can connect it in project settings",
    ]);
  });

  test("a disconnected connection prints not connected", async () => {
    const { ports } = listing([
      connection({ state: "disconnected", account: null }),
    ]);
    expect(await status(ports)).toEqual([
      'Notion ("notion"): not connected — a project admin can connect it in project settings',
    ]);
  });

  test("reconnect_required asks an admin to reconnect", async () => {
    const { ports } = listing([
      connection({ state: "reconnect_required", reasonCode: "grant_expired" }),
    ]);
    expect(await status(ports)).toEqual([
      'Notion ("notion"): reconnect required — a project admin can reconnect it in project settings',
    ]);
  });

  test("a connection is shown by its own label, with the name auth uses", async () => {
    const { ports } = listing([
      connection({ name: "acme-docs", label: "Acme docs" }),
    ]);
    expect(await status(ports, [server({ connection: "acme-docs" })])).toEqual([
      'Acme docs ("acme-docs"): connected as Ada / Acme',
    ]);
  });

  test("another state prints the state name", async () => {
    const { ports } = listing([connection({ state: "connecting" })]);
    expect(await status(ports)).toEqual(['Notion ("notion"): connecting']);
  });

  test("a failed list call prints one neutral warning and reports nothing else", async () => {
    const failing: PushConnectionStatusPorts = {
      listManagedConnections: () => Promise.resolve({ ok: false, status: 500 }),
    };
    const result = await report(failing, [
      server({ url: "https://elsewhere.test/mcp" }),
    ]);
    expect(result.status).toHaveLength(1);
    expect(result.status[0]).toContain("Couldn't check the status");
    expect(result.status[0]).toContain("the push still succeeded");
    expect(result.problems).toEqual([]);
  });

  test("a thrown list call prints the same warning instead of failing", async () => {
    const throwing: PushConnectionStatusPorts = {
      listManagedConnections: () => Promise.reject(new Error("offline")),
    };
    expect(await status(throwing)).toHaveLength(1);
  });

  test("no servers prints nothing and makes no call", async () => {
    const { ports, calls } = listing([connection({})]);
    expect(await report(ports, [])).toEqual({
      status: [],
      warnings: [],
      problems: [],
    });
    expect(calls()).toBe(0);
  });
});

describe("pushConnectionReport URL checks", () => {
  test("an auth entry whose URL isn't its existing connection's is a problem", async () => {
    const { ports } = listing([connection({})]);
    const { problems } = await report(ports, [
      server({ url: "https://mcp.notion.test/mcp" }),
    ]);
    expect(problems).toEqual([
      `Step "read" MCP server "docs" uses the project's Notion connection (auth: { connection: "notion" }), ` +
        `but its URL is not the connection's. Point it at ${NOTION_URL}.`,
    ]);
  });

  test("a mismatch is reported for a connection in any state, disconnected included", async () => {
    const { ports } = listing([
      connection({ state: "disconnected", account: null }),
    ]);
    const { problems } = await report(ports, [
      server({ url: "https://elsewhere.test/mcp" }),
    ]);
    expect(problems).toHaveLength(1);
  });

  test("no problem when the connection doesn't exist yet", async () => {
    const { ports } = listing([]);
    const { problems, warnings } = await report(ports, [
      server({ url: "https://elsewhere.test/mcp" }),
    ]);
    expect(problems).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("a URL that normalizes to the connection's resource is fine", async () => {
    const { ports } = listing([connection({})]);
    const { problems } = await report(ports, [
      server({ url: "HTTPS://MCP.Notion.com:443/mcp/" }),
    ]);
    expect(problems).toEqual([]);
  });

  test("an auth entry with no known URL is left to launch registration", async () => {
    const { ports } = listing([connection({})]);
    const { problems } = await report(ports, [server({ url: null })]);
    expect(problems).toEqual([]);
  });

  test("a remote without auth pointing at a connection is a warning naming the auth to add", async () => {
    const { ports } = listing([connection({})]);
    const result = await report(ports, [
      server({ connection: null, url: `${NOTION_URL}/` }),
    ]);
    expect(result.status).toEqual([]);
    expect(result.problems).toEqual([]);
    expect(result.warnings).toEqual([
      `Step "read" MCP server "docs" points at the project's Notion connection (${NOTION_URL}) but has no auth, ` +
        `so it won't use the connection's credentials. Add auth: { connection: "notion" } to it.`,
    ]);
  });

  test("problems fail the command after the push; warnings alone don't", async () => {
    const { ports } = listing([connection({})]);
    const warningsOnly = await report(ports, [
      server({ connection: null, url: NOTION_URL }),
    ]);
    expect(() => {
      assertNoPushConnectionProblems(warningsOnly);
    }).not.toThrow();

    const mismatched = await report(ports, [
      server({ url: "https://elsewhere.test/mcp" }),
    ]);
    let caught: unknown;
    try {
      assertNoPushConnectionProblems(mismatched);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CliError);
    const error = caught as CliError;
    expect(error.code).toBe("push_connection_url_mismatch");
    expect(error.exitCode).toBe(1);
    expect(error.message).toStartWith(
      "Pushed, but these MCP servers will fail at launch with SCARN_MCP_CONNECTION_AUTH_INVALID:",
    );
    expect(error.message).toContain(`Point it at ${NOTION_URL}.`);
  });

  test("a remote without auth pointing elsewhere reports nothing", async () => {
    const { ports } = listing([connection({})]);
    expect(
      await report(ports, [
        server({ connection: null, url: "https://elsewhere.test/mcp" }),
      ]),
    ).toEqual({ status: [], warnings: [], problems: [] });
  });
});

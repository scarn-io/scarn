/**
 * Unit tests for {@link openMcpBridgeSession}: endpoint and run args per
 * placement, the token, the runner env, the bind address, and stop / run
 * abort closing the pool and the server.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  MCP_BRIDGE_TOKEN_ENV,
  MCP_BRIDGE_URL_ENV,
} from "@scarn/sdk/contracts/mcp-bridge";
import {
  mcpBridgeStepEnv,
  openMcpBridgeSession,
  resolveMcpBridgeBindAddress,
  type McpBridgeSession,
} from "../../../../src/runtime/mcp-bridge/infra";
import { HOST_GATEWAY_RUN_ARGS } from "../../../../src/runtime/runtime-service/infra/devcontainer-mount-injection";
import type { ResolvedOpenCodeMcpServerConfig } from "../../../../src/common/contracts/opencode-mcp";
import type { McpToolCallPlacement } from "../../../../src/work/task-run/application/mcp-tool-caller";
import {
  createFakePool,
  untilAborted,
  type FakePool,
} from "./helpers/fake-mcp-connection-pool";

const servers: Record<string, ResolvedOpenCodeMcpServerConfig> = {
  files: {
    type: "local",
    command: ["bun", "server.ts"],
  },
};

const sessions: McpBridgeSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.stop()));
});

async function open(
  options: {
    placement?: McpToolCallPlacement;
    signal?: AbortSignal;
    pool?: FakePool;
  } = {},
) {
  const pool =
    options.pool ??
    createFakePool(() =>
      Promise.resolve({ status: "ok", content: [], structuredContent: null }),
    );
  const session = await openMcpBridgeSession({
    servers,
    placement: options.placement ?? {
      kind: "host",
      workspaceDir: "/workspace",
    },
    env: {},
    signal: options.signal ?? new AbortController().signal,
    bindAddress: "127.0.0.1",
    poolFactory: pool.factory,
  });
  sessions.push(session);
  return { session, pool };
}

function call(endpoint: string, token: string): Promise<Response> {
  return fetch(`${endpoint}/mcp/call`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ server: "files", tool: "read", args: {} }),
  });
}

describe("openMcpBridgeSession", () => {
  test("a host placement gets a loopback endpoint and no run args", async () => {
    const { session } = await open();
    expect(session.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(session.runArgs).toEqual([]);
    expect((await call(session.endpoint, session.token)).status).toBe(200);
  });

  test("a container placement gets host.docker.internal and the host-gateway run args", async () => {
    const { session } = await open({
      placement: {
        kind: "container",
        containerId: "abc",
        workspaceDir: "/workspace",
      },
    });
    expect(session.endpoint).toMatch(/^http:\/\/host\.docker\.internal:\d+$/);
    expect(session.runArgs).toEqual(HOST_GATEWAY_RUN_ARGS);
  });

  test("each session gets its own 32-byte token", async () => {
    const a = await open();
    const b = await open();
    expect(a.session.token).toMatch(/^[0-9a-f]{64}$/);
    expect(a.session.token).not.toBe(b.session.token);
    expect((await call(a.session.endpoint, b.session.token)).status).toBe(401);
  });

  test("mcpBridgeStepEnv maps the endpoint and token to the SDK's env names", () => {
    expect(mcpBridgeStepEnv({ endpoint: "http://h:1", token: "t" })).toEqual({
      [MCP_BRIDGE_URL_ENV]: "http://h:1",
      [MCP_BRIDGE_TOKEN_ENV]: "t",
    });
  });

  test("stop aborts in-flight calls, closes the pool and stops the server", async () => {
    const pool = createFakePool((c) => untilAborted(c.signal));
    const { session } = await open({ pool });
    const pending = call(session.endpoint, session.token).catch(
      () => undefined,
    );
    await waitFor(() => pool.calls.length === 1);
    await session.stop();
    await session.stop();
    expect(pool.calls[0]?.signal.aborted).toBe(true);
    expect(pool.closeAllCount()).toBe(1);
    await pending;
    expect(
      await call(session.endpoint, session.token).then(
        () => "answered",
        () => "refused",
      ),
    ).toBe("refused");
  });

  test("the run aborting stops the session", async () => {
    const run = new AbortController();
    const { session, pool } = await open({ signal: run.signal });
    run.abort();
    expect(pool.closeAllCount()).toBe(1);
    expect(pool.input().signal.aborted).toBe(true);
    await session.stop();
    expect(
      await call(session.endpoint, session.token).then(
        () => "answered",
        () => "refused",
      ),
    ).toBe("refused");
  });

  test("a session opened on an aborted run is already stopped", async () => {
    const run = new AbortController();
    run.abort();
    const { pool } = await open({ signal: run.signal });
    expect(pool.closeAllCount()).toBe(1);
  });
});

describe("resolveMcpBridgeBindAddress", () => {
  test("SCARN_MCP_BRIDGE_BIND overrides the platform default", () => {
    expect(
      resolveMcpBridgeBindAddress({ SCARN_MCP_BRIDGE_BIND: " 10.0.0.2 " }),
    ).toBe("10.0.0.2");
  });

  test("defaults like the git credential relay", () => {
    expect(resolveMcpBridgeBindAddress({}, "linux")).toBe("0.0.0.0");
    expect(resolveMcpBridgeBindAddress({}, "darwin")).toBe("127.0.0.1");
    expect(
      resolveMcpBridgeBindAddress({ SCARN_MCP_BRIDGE_BIND: " " }, "win32"),
    ).toBe("127.0.0.1");
  });
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

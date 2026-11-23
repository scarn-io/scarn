import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  McpConnectionOpenEvent,
  McpConnectionPoolInput,
  McpPooledToolCall,
} from "../../../../src/work/task-run/application/mcp-connection-pool";
import type { McpToolCallOutcome } from "../../../../src/work/task-run/application/mcp-tool-caller";
import {
  SdkMcpConnectionPool,
  createSdkMcpConnectionPool,
  type McpConnector,
} from "../../../../src/work/task-run/infra/sdk-mcp-connection-pool";
import type {
  McpCallToolInput,
  McpConnectInput,
  McpConnectResult,
} from "../../../../src/work/task-run/infra/sdk-mcp-tool-caller";

/**
 * Pool behaviour against a fake connector (opening, reuse, reopen, close),
 * then real round trips against the stdio fixture server.
 */

class FakeConnection {
  closed = false;
  disposed = false;
  constructor(readonly id: number) {}
  dispose(): Promise<void> {
    this.closed = true;
    this.disposed = true;
    return Promise.resolve();
  }
}

class FakeConnector implements McpConnector<FakeConnection> {
  readonly opened: FakeConnection[] = [];
  readonly connectInputs: McpConnectInput[] = [];
  readonly calls: Array<{ connection: number; tool: string }> = [];
  failures: Array<McpConnectResult<FakeConnection>> = [];
  gate: Promise<void> | null = null;
  onCall: (
    connection: FakeConnection,
    input: McpCallToolInput,
  ) => Promise<McpToolCallOutcome> = (connection, input) =>
    Promise.resolve({
      status: "ok",
      content: [
        { type: "text", text: `${input.tool}@${String(connection.id)}` },
      ],
      structuredContent: null,
    });

  async connect(
    input: McpConnectInput,
  ): Promise<McpConnectResult<FakeConnection>> {
    this.connectInputs.push(input);
    if (this.gate !== null) await this.gate;
    if (input.signal.aborted) return { status: "aborted" };
    const failure = this.failures.shift();
    if (failure !== undefined) return failure;
    const connection = new FakeConnection(this.opened.length + 1);
    this.opened.push(connection);
    return { status: "connected", connection };
  }

  callTool(
    connection: FakeConnection,
    input: McpCallToolInput,
  ): Promise<McpToolCallOutcome> {
    this.calls.push({ connection: connection.id, tool: input.tool });
    return this.onCall(connection, input);
  }
}

function poolInput(
  overrides: Partial<McpConnectionPoolInput> = {},
): McpConnectionPoolInput {
  return {
    servers: {
      notion: { type: "local", command: ["notion-mcp"] },
      linear: { type: "remote", url: "https://linear.example/mcp" },
    },
    placement: { kind: "host", workspaceDir: "/work" },
    env: { A: "1" },
    signal: new AbortController().signal,
    ...overrides,
  };
}

function toolCall(
  overrides: Partial<McpPooledToolCall> = {},
): McpPooledToolCall {
  return {
    tool: "echo",
    args: {},
    timeoutMs: 5_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("SdkMcpConnectionPool", () => {
  test("opens one connection per server and reuses it across calls", async () => {
    const connector = new FakeConnector();
    const opens: McpConnectionOpenEvent[] = [];
    const pool = new SdkMcpConnectionPool(
      poolInput({ onOpen: (event) => opens.push(event) }),
      connector,
    );

    await pool.call("notion", toolCall({ tool: "a" }));
    await pool.call("notion", toolCall({ tool: "b" }));
    await pool.call("linear", toolCall({ tool: "c" }));

    expect(connector.calls).toEqual([
      { connection: 1, tool: "a" },
      { connection: 1, tool: "b" },
      { connection: 2, tool: "c" },
    ]);
    expect(opens.map((event) => [event.serverKey, event.reopen])).toEqual([
      ["notion", false],
      ["linear", false],
    ]);
    expect(connector.connectInputs[0]).toMatchObject({
      server: { type: "local", command: ["notion-mcp"] },
      placement: { kind: "host", workspaceDir: "/work" },
      env: { A: "1" },
    });
  });

  test("concurrent first calls share one opening", async () => {
    const connector = new FakeConnector();
    const { promise: gate, resolve: release } =
      Promise.withResolvers<undefined>();
    connector.gate = gate;
    const pool = new SdkMcpConnectionPool(poolInput(), connector);

    const pending = Promise.all([
      pool.call("notion", toolCall({ tool: "a" })),
      pool.call("notion", toolCall({ tool: "b" })),
    ]);
    release(undefined);
    await pending;

    expect(connector.connectInputs).toHaveLength(1);
    expect(connector.calls.map((call) => call.connection)).toEqual([1, 1]);
  });

  test("a connection that died is reopened once before the next request", async () => {
    const connector = new FakeConnector();
    const opens: McpConnectionOpenEvent[] = [];
    const pool = new SdkMcpConnectionPool(
      poolInput({ onOpen: (event) => opens.push(event) }),
      connector,
    );
    await pool.call("notion", toolCall());
    const first = connector.opened[0];
    if (first === undefined) throw new Error("no connection");
    first.closed = true;

    const outcome = await pool.call("notion", toolCall({ tool: "after" }));

    expect(outcome).toMatchObject({ status: "ok" });
    expect(first.disposed).toBe(true);
    expect(connector.calls.at(-1)).toEqual({ connection: 2, tool: "after" });
    expect(opens.map((event) => event.reopen)).toEqual([false, true]);
  });

  test("a failed reopen is unavailable and the next call tries again", async () => {
    const connector = new FakeConnector();
    const pool = new SdkMcpConnectionPool(poolInput(), connector);
    await pool.call("notion", toolCall());
    const first = connector.opened[0];
    if (first === undefined) throw new Error("no connection");
    first.closed = true;
    connector.failures = [
      { status: "unavailable", reason: "start", detail: "exited" },
    ];

    expect(await pool.call("notion", toolCall())).toEqual({
      status: "unavailable",
      reason: "start",
      detail: "exited",
    });
    expect(await pool.call("notion", toolCall())).toMatchObject({
      status: "ok",
    });
    expect(connector.connectInputs).toHaveLength(3);
  });

  test("a request whose connection dies mid-call is not retried", async () => {
    const connector = new FakeConnector();
    connector.onCall = (connection) => {
      connection.closed = true;
      return Promise.resolve({
        status: "unavailable",
        reason: "connect",
        detail: "connection closed after tools/call was sent",
      });
    };
    const pool = new SdkMcpConnectionPool(poolInput(), connector);

    expect(await pool.call("notion", toolCall())).toMatchObject({
      status: "unavailable",
      reason: "connect",
    });
    expect(connector.calls).toHaveLength(1);
    expect(connector.connectInputs).toHaveLength(1);
  });

  test("an unknown server key is unavailable without connecting", async () => {
    const connector = new FakeConnector();
    const pool = new SdkMcpConnectionPool(poolInput(), connector);

    expect(await pool.call("github", toolCall())).toMatchObject({
      status: "unavailable",
      reason: "connect",
    });
    expect(connector.connectInputs).toHaveLength(0);
  });

  test("a call that times out waiting for the opening is a timeout; the opening is kept", async () => {
    const connector = new FakeConnector();
    const { promise: gate, resolve: release } =
      Promise.withResolvers<undefined>();
    connector.gate = gate;
    const pool = new SdkMcpConnectionPool(poolInput(), connector);

    expect(await pool.call("notion", toolCall({ timeoutMs: 50 }))).toEqual({
      status: "timeout",
    });
    release(undefined);
    expect(await pool.call("notion", toolCall())).toMatchObject({
      status: "ok",
    });
    expect(connector.connectInputs).toHaveLength(1);
  });

  test("the call's own abort returns aborted without closing the pool", async () => {
    const connector = new FakeConnector();
    const controller = new AbortController();
    controller.abort();
    const pool = new SdkMcpConnectionPool(poolInput(), connector);

    expect(
      await pool.call("notion", toolCall({ signal: controller.signal })),
    ).toEqual({ status: "aborted" });
    expect(await pool.call("notion", toolCall())).toMatchObject({
      status: "ok",
    });
  });

  test("closeAll disposes every connection, is idempotent, and later calls are aborted", async () => {
    const connector = new FakeConnector();
    const pool = new SdkMcpConnectionPool(poolInput(), connector);
    await pool.call("notion", toolCall());
    await pool.call("linear", toolCall());

    await Promise.all([pool.closeAll(), pool.closeAll()]);

    expect(connector.opened.map((connection) => connection.disposed)).toEqual([
      true,
      true,
    ]);
    expect(await pool.call("notion", toolCall())).toEqual({
      status: "aborted",
    });
    expect(connector.connectInputs).toHaveLength(2);
  });

  test("aborting the run aborts in-flight calls and closes the pool", async () => {
    const connector = new FakeConnector();
    const run = new AbortController();
    connector.onCall = (_connection, input) =>
      new Promise((resolve) => {
        input.signal.addEventListener("abort", () => {
          resolve({ status: "aborted" });
        });
      });
    const pool = new SdkMcpConnectionPool(
      poolInput({ signal: run.signal }),
      connector,
    );
    const pending = pool.call("notion", toolCall());
    await Bun.sleep(0);

    run.abort();

    expect(await pending).toEqual({ status: "aborted" });
    await pool.closeAll();
    expect(connector.opened[0]?.disposed).toBe(true);
  });

  test("closing while a connection is opening disposes it once opened", async () => {
    const connector = new FakeConnector();
    const { promise: gate, resolve: release } =
      Promise.withResolvers<undefined>();
    connector.gate = gate;
    connector.connect = async function (input) {
      this.connectInputs.push(input);
      if (this.gate !== null) await this.gate;
      const connection = new FakeConnection(this.opened.length + 1);
      this.opened.push(connection);
      return { status: "connected", connection };
    };
    const pool = new SdkMcpConnectionPool(poolInput(), connector);
    const pending = pool.call("notion", toolCall());

    const closing = pool.closeAll();
    release(undefined);
    await closing;

    expect(await pending).toEqual({ status: "aborted" });
    expect(connector.opened[0]?.disposed).toBe(true);
    expect(connector.calls).toHaveLength(0);
  });
});

const FIXTURE_SERVER_PATH = path.join(
  import.meta.dirname,
  "fixtures",
  "tool-call-mcp-server.ts",
);

describe("createSdkMcpConnectionPool over stdio on the host", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "scarn-mcp-pool-"));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  function stdioPool(onOpen?: (event: McpConnectionOpenEvent) => void) {
    return createSdkMcpConnectionPool({
      servers: {
        fixture: {
          type: "local",
          command: [process.execPath, "run", FIXTURE_SERVER_PATH],
          environment: {
            FIXTURE_CALLS_FILE: path.join(scratch, "calls"),
            FIXTURE_PID_FILE: path.join(scratch, "pid"),
          },
        },
      },
      placement: { kind: "host", workspaceDir: scratch },
      env: hostEnv(),
      signal: new AbortController().signal,
      ...(onOpen === undefined ? {} : { onOpen }),
    });
  }

  function serverPid(): number {
    return Number(readFileSync(path.join(scratch, "pid"), "utf8"));
  }

  test("two calls share one server process, which closeAll stops", async () => {
    const pool = stdioPool();

    const first = await pool.call(
      "fixture",
      toolCall({ args: { text: "one" }, timeoutMs: 15_000 }),
    );
    const pid = serverPid();
    const second = await pool.call(
      "fixture",
      toolCall({ args: { text: "two" }, timeoutMs: 15_000 }),
    );

    expect([first, second]).toEqual([
      {
        status: "ok",
        content: [{ type: "text", text: "echo: one" }],
        structuredContent: null,
      },
      {
        status: "ok",
        content: [{ type: "text", text: "echo: two" }],
        structuredContent: null,
      },
    ]);
    expect(serverPid()).toBe(pid);
    expect(isAlive(pid)).toBe(true);

    await pool.closeAll();
    await waitFor(() => !isAlive(pid));
  });

  test("a server that crashed mid-call is restarted for the next call", async () => {
    const opens: McpConnectionOpenEvent[] = [];
    const pool = stdioPool((event) => opens.push(event));

    expect(
      await pool.call(
        "fixture",
        toolCall({ tool: "crash", timeoutMs: 15_000 }),
      ),
    ).toMatchObject({ status: "unavailable", reason: "connect" });
    const crashedPid = serverPid();
    expect(
      await pool.call(
        "fixture",
        toolCall({ args: { text: "x" }, timeoutMs: 15_000 }),
      ),
    ).toMatchObject({ status: "ok" });

    expect(serverPid()).not.toBe(crashedPid);
    expect(opens.map((event) => event.reopen)).toEqual([false, true]);
    expect(
      readFileSync(path.join(scratch, "calls"), "utf8")
        .split("\n")
        .filter(Boolean),
    ).toEqual(["crash", "echo"]);
    await pool.closeAll();
  });

  test("closeAll before any call never starts the server", async () => {
    const pool = stdioPool();

    await pool.closeAll();

    expect(await pool.call("fixture", toolCall())).toEqual({
      status: "aborted",
    });
    expect(existsSync(path.join(scratch, "pid"))).toBe(false);
  });
});

function hostEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await Bun.sleep(20);
  }
}

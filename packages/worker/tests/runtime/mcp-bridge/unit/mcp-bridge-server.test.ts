/**
 * Unit tests for {@link McpBridgeServer} over real HTTP on loopback with a
 * fake pool: auth, routing, body limit, request validation, each outcome and
 * abort mid-call.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { McpBridge } from "../../../../src/runtime/mcp-bridge/application/mcp-bridge";
import {
  MAX_MCP_BRIDGE_REQUEST_BYTES,
  McpBridgeServer,
} from "../../../../src/runtime/mcp-bridge/infra";
import type { ResolvedOpenCodeMcpServerConfig } from "../../../../src/common/contracts/opencode-mcp";
import type { McpToolCallOutcome } from "../../../../src/work/task-run/application/mcp-tool-caller";
import {
  createFakePool,
  untilAborted,
  type FakePoolCall,
} from "./helpers/fake-mcp-connection-pool";

const TOKEN = "bridge-test-token-0123456789abcdef";

const servers: Record<string, ResolvedOpenCodeMcpServerConfig> = {
  files: {
    type: "local",
    command: ["bun", "server.ts"],
  },
};

let server: McpBridgeServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

async function start(
  respond: (call: FakePoolCall) => Promise<McpToolCallOutcome> = () =>
    Promise.resolve({ status: "ok", content: [], structuredContent: null }),
  options: { maxResultBytes?: number; signal?: AbortSignal } = {},
) {
  const pool = createFakePool(respond);
  const bridge = new McpBridge({
    servers,
    placement: { kind: "host", workspaceDir: "/workspace" },
    env: {},
    poolFactory: pool.factory,
    signal: options.signal ?? new AbortController().signal,
    maxResultBytes: options.maxResultBytes,
  });
  server = new McpBridgeServer({
    bridge,
    token: TOKEN,
    bindAddress: "127.0.0.1",
  });
  const baseUrl = `http://127.0.0.1:${String(await server.start())}`;
  return { pool, baseUrl };
}

function post(
  baseUrl: string,
  body: string | Record<string, unknown>,
  options: {
    authorization?: string | null;
    pathname?: string;
    signal?: AbortSignal;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const authorization =
    options.authorization === undefined
      ? `Bearer ${TOKEN}`
      : options.authorization;
  if (authorization !== null) headers["Authorization"] = authorization;
  return fetch(`${baseUrl}${options.pathname ?? "/mcp/call"}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: options.signal,
  });
}

const CALL = { server: "files", tool: "read", args: { path: "a.txt" } };

describe("McpBridgeServer", () => {
  test("answers 200 with an ok outcome", async () => {
    const ok: McpToolCallOutcome = {
      status: "ok",
      content: [{ type: "text", text: "hi" }],
      structuredContent: { n: 1 },
    };
    const { baseUrl, pool } = await start(() => Promise.resolve(ok));
    const response = await post(baseUrl, CALL);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(ok);
    expect(pool.calls[0]).toMatchObject({
      serverKey: "files",
      tool: "read",
      args: { path: "a.txt" },
    });
  });

  test.each<McpToolCallOutcome>([
    { status: "tool_error", content: [{ type: "text", text: "bad" }] },
    { status: "unavailable", reason: "tool_not_found", detail: "no read" },
    { status: "timeout" },
  ])("answers 200 with a %o outcome", async (outcome) => {
    const { baseUrl } = await start(() => Promise.resolve(outcome));
    const response = await post(baseUrl, CALL);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(outcome);
  });

  test("answers 200 with output_too_large for a result over the cap", async () => {
    const { baseUrl } = await start(undefined, { maxResultBytes: 16 });
    const response = await post(baseUrl, CALL);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "unavailable",
      reason: "output_too_large",
    });
  });

  test("rejects a missing token with 401", async () => {
    const { baseUrl, pool } = await start();
    const response = await post(baseUrl, CALL, { authorization: null });
    expect(response.status).toBe(401);
    expect(await response.json()).toHaveProperty("error");
    expect(pool.calls).toHaveLength(0);
  });

  test("rejects a wrong token with 401", async () => {
    const { baseUrl } = await start();
    for (const authorization of [
      "Bearer wrong",
      `Bearer ${TOKEN}x`,
      `Basic ${TOKEN}`,
    ]) {
      expect((await post(baseUrl, CALL, { authorization })).status).toBe(401);
    }
  });

  test("checks the token before routing and parsing", async () => {
    const { baseUrl } = await start();
    expect(
      (await post(baseUrl, "{", { authorization: null, pathname: "/nope" }))
        .status,
    ).toBe(401);
  });

  test("answers 404 for other paths and methods", async () => {
    const { baseUrl } = await start();
    expect((await post(baseUrl, CALL, { pathname: "/mcp" })).status).toBe(404);
    expect((await post(baseUrl, CALL, { pathname: "/" })).status).toBe(404);
    const response = await fetch(`${baseUrl}/mcp/call`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(404);
  });

  test("answers 404 for a server the step didn't declare", async () => {
    const { baseUrl, pool } = await start();
    const response = await post(baseUrl, { ...CALL, server: "github" });
    expect(response.status).toBe(404);
    expect((await response.json()) as { error: string }).toEqual({
      error: 'MCP server "github" is not declared by this step',
    });
    expect(pool.calls).toHaveLength(0);
  });

  test("answers 400 for bad JSON or a body off the schema", async () => {
    const { baseUrl } = await start();
    for (const body of [
      "{",
      "[]",
      { server: "files", tool: "read" },
      { ...CALL, extra: true },
      { ...CALL, args: [] },
      { ...CALL, timeoutMs: -1 },
      { ...CALL, server: "" },
    ]) {
      const response = await post(baseUrl, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toHaveProperty("error");
    }
  });

  test("answers 413 for a body over 1 MiB", async () => {
    const { baseUrl } = await start();
    const response = await post(baseUrl, {
      ...CALL,
      args: { blob: "x".repeat(MAX_MCP_BRIDGE_REQUEST_BYTES) },
    });
    expect(response.status).toBe(413);
  });

  test("answers 503 when the run aborts mid-call", async () => {
    const run = new AbortController();
    const { baseUrl, pool } = await start((call) => untilAborted(call.signal), {
      signal: run.signal,
    });
    const pending = post(baseUrl, CALL);
    await waitFor(() => pool.calls.length === 1);
    run.abort();
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toHaveProperty("error");
  });

  test("a client disconnecting mid-call aborts the call", async () => {
    let callSignal: AbortSignal | null = null;
    const { baseUrl } = await start((call) => {
      callSignal = call.signal;
      return untilAborted(call.signal);
    });
    const client = new AbortController();
    const pending = post(baseUrl, CALL, { signal: client.signal });
    await waitFor(() => callSignal !== null);
    client.abort();
    await pending.catch(() => undefined);
    await waitFor(() => callSignal?.aborted === true);
  });

  test("stop is idempotent", async () => {
    await start();
    await server?.stop();
    await server?.stop();
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

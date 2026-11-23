/**
 * Unit tests for {@link McpBridge} over a fake pool: routing, timeouts, the
 * result cap, abort and the task-log lines.
 */
import { describe, expect, test } from "bun:test";
import {
  McpBridge,
  mcpBridgeCallTimeoutMs,
} from "../../../../src/runtime/mcp-bridge/application/mcp-bridge";
import type { ResolvedOpenCodeMcpServerConfig } from "../../../../src/common/contracts/opencode-mcp";
import type { McpToolCallOutcome } from "../../../../src/work/task-run/application/mcp-tool-caller";
import { DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS } from "../../../../src/work/task-run/application/mcp-tool-step-observability";
import { createRecordingWorkLogger } from "../../../support/recording-work-logger";
import {
  createFakePool,
  untilAborted,
  type FakePoolCall,
} from "./helpers/fake-mcp-connection-pool";

const SECRET_ARG = "arg-secret-value";
const SECRET_CONTENT = "content-secret-value";

const servers: Record<string, ResolvedOpenCodeMcpServerConfig> = {
  notion: {
    type: "remote",
    url: "https://mcp.notion.example/mcp",
    timeout: { execution: 30_000 },
  },
  files: {
    type: "local",
    command: ["bun", "server.ts"],
  },
};

const okOutcome: McpToolCallOutcome = {
  status: "ok",
  content: [{ type: "text", text: SECRET_CONTENT }],
  structuredContent: { answer: 42 },
};

function makeBridge(
  respond: (call: FakePoolCall) => Promise<McpToolCallOutcome> = () =>
    Promise.resolve(okOutcome),
  options: { maxResultBytes?: number; signal?: AbortSignal } = {},
) {
  const pool = createFakePool(respond);
  const { entries, logger } = createRecordingWorkLogger();
  const bridge = new McpBridge({
    servers,
    authoredServers: {
      notion: { type: "ref", name: "notion", auth: { connection: "notion" } },
    } as never,
    placement: { kind: "host", workspaceDir: "/workspace" },
    env: { TOKEN: "env" },
    poolFactory: pool.factory,
    logger,
    signal: options.signal ?? new AbortController().signal,
    maxResultBytes: options.maxResultBytes,
  });
  return { bridge, pool, entries };
}

describe("McpBridge", () => {
  test("creates its pool over the session's servers, placement and env", () => {
    const { pool } = makeBridge();
    expect(pool.input().servers).toBe(servers);
    expect(pool.input().placement).toEqual({
      kind: "host",
      workspaceDir: "/workspace",
    });
    expect(pool.input().env).toEqual({ TOKEN: "env" });
  });

  test("forwards a call to the pool and returns the outcome", async () => {
    const { bridge, pool } = makeBridge();
    const result = await bridge.call({
      server: "notion",
      tool: "search",
      args: { query: "x" },
    });
    expect(result).toEqual({ status: "outcome", response: okOutcome });
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0]).toMatchObject({
      serverKey: "notion",
      tool: "search",
      args: { query: "x" },
    });
  });

  test.each<Exclude<McpToolCallOutcome, { status: "aborted" }>>([
    { status: "tool_error", content: [{ type: "text", text: "bad" }] },
    { status: "unavailable", reason: "start", detail: "npx not found" },
    { status: "timeout" },
  ])("returns a %o outcome as is", async (outcome) => {
    const { bridge } = makeBridge(() => Promise.resolve(outcome));
    expect(
      await bridge.call({ server: "files", tool: "read", args: {} }),
    ).toEqual({ status: "outcome", response: outcome });
  });

  test("an undeclared server is not_declared and never reaches the pool", async () => {
    const { bridge, pool, entries } = makeBridge();
    expect(await bridge.call({ server: "nope", tool: "x", args: {} })).toEqual({
      status: "not_declared",
    });
    expect(pool.calls).toHaveLength(0);
    expect(entries).toHaveLength(0);
  });

  test("a pool abort is aborted", async () => {
    const { bridge } = makeBridge(() => Promise.resolve({ status: "aborted" }));
    expect(
      await bridge.call({ server: "files", tool: "read", args: {} }),
    ).toEqual({ status: "aborted" });
  });

  test("a result over the cap is unavailable / output_too_large", async () => {
    const { bridge } = makeBridge(undefined, { maxResultBytes: 64 });
    const result = await bridge.call({
      server: "notion",
      tool: "search",
      args: {},
    });
    expect(result).toMatchObject({
      status: "outcome",
      response: { status: "unavailable", reason: "output_too_large" },
    });
    if (result.status === "outcome" && result.response.status === "unavailable")
      expect(result.response.detail).not.toContain(SECRET_CONTENT);
  });

  test("the timeout is the smallest of server, request and the default", async () => {
    const { bridge, pool } = makeBridge();
    await bridge.call({ server: "notion", tool: "a", args: {} });
    await bridge.call({ server: "notion", tool: "b", args: {}, timeoutMs: 5 });
    await bridge.call({ server: "files", tool: "c", args: {} });
    await bridge.call({
      server: "files",
      tool: "d",
      args: {},
      timeoutMs: DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS * 2,
    });
    expect(pool.calls.map((call) => call.timeoutMs)).toEqual([
      30_000,
      5,
      DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
      DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
    ]);
  });

  test("mcpBridgeCallTimeoutMs", () => {
    expect(mcpBridgeCallTimeoutMs(undefined, undefined)).toBe(
      DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
    );
    expect(mcpBridgeCallTimeoutMs(1_000, 2_000)).toBe(1_000);
    expect(mcpBridgeCallTimeoutMs(2_000, 1_000)).toBe(1_000);
    expect(
      mcpBridgeCallTimeoutMs(DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS + 1, undefined),
    ).toBe(DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS);
  });

  test("the run's signal aborts an in-flight call", async () => {
    const run = new AbortController();
    const { bridge } = makeBridge((call) => untilAborted(call.signal), {
      signal: run.signal,
    });
    const pending = bridge.call({ server: "files", tool: "read", args: {} });
    run.abort();
    expect(await pending).toEqual({ status: "aborted" });
  });

  test("the caller's signal aborts its call", async () => {
    const { bridge } = makeBridge((call) => untilAborted(call.signal));
    const caller = new AbortController();
    const pending = bridge.call(
      { server: "files", tool: "read", args: {} },
      caller.signal,
    );
    caller.abort();
    expect(await pending).toEqual({ status: "aborted" });
  });

  test("close closes the pool", async () => {
    const { bridge, pool } = makeBridge();
    await bridge.close();
    expect(pool.closeAllCount()).toBe(1);
  });

  test("logs starting once per server, with its transport", async () => {
    const { bridge, entries } = makeBridge();
    await bridge.call({ server: "notion", tool: "a", args: {} });
    await bridge.call({ server: "notion", tool: "b", args: {} });
    await bridge.call({ server: "files", tool: "c", args: {} });
    const starting = entries
      .map((entry) => entry.message)
      .filter((message) => message.startsWith("mcp: starting"));
    expect(starting).toEqual([
      "mcp: starting notion (managed)",
      "mcp: starting files (local)",
    ]);
  });

  test("logs each call with arg keys and block count, never values or content", async () => {
    const { bridge, entries } = makeBridge();
    await bridge.call({
      server: "notion",
      tool: "search",
      args: { query: SECRET_ARG },
    });
    const called = entries.find((entry) =>
      entry.message.startsWith("mcp: notion.search called in"),
    );
    expect(called?.level).toBe("log");
    expect(called?.scope).toBe("step");
    expect(called?.message).toMatch(
      /^mcp: notion\.search called in \d+\.\ds \(ok\)$/,
    );
    expect(called?.details).toMatchObject({
      argKeys: ["query"],
      contentBlocks: 1,
    });
    expect(JSON.stringify(entries)).not.toContain(SECRET_ARG);
    expect(JSON.stringify(entries)).not.toContain(SECRET_CONTENT);
  });

  test.each<[McpToolCallOutcome, string]>([
    [{ status: "tool_error", content: [] }, "tool_error"],
    [
      { status: "unavailable", reason: "connect", detail: "refused" },
      "unavailable:connect",
    ],
    [{ status: "timeout" }, "timeout"],
    [{ status: "aborted" }, "aborted"],
  ])("logs a %o call as (%s)", async (outcome, label) => {
    const { bridge, entries } = makeBridge(() => Promise.resolve(outcome));
    await bridge.call({ server: "files", tool: "read", args: {} });
    expect(entries.at(-1)?.message).toEndWith(`(${label})`);
  });

  test("logs a capped result as (unavailable:output_too_large)", async () => {
    const { bridge, entries } = makeBridge(undefined, { maxResultBytes: 64 });
    await bridge.call({ server: "files", tool: "read", args: {} });
    expect(entries.at(-1)?.message).toEndWith("(unavailable:output_too_large)");
  });
});

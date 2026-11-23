/**
 * Unit tests for {@link runDirectMcpHealthChecks}: a code step's MCP checks
 * as direct calls through the run's connection pool (ADR 0016 decision 8).
 */
import { describe, expect, test } from "bun:test";
import { runDirectMcpHealthChecks } from "../../../../src/work/task-run/application/run-direct-mcp-health-checks";
import type { McpToolCallOutcome } from "../../../../src/work/task-run/application/mcp-tool-caller";
import {
  createFakePool,
  type FakePoolCall,
} from "../../../runtime/mcp-bridge/unit/helpers/fake-mcp-connection-pool";
import { cliHealthCheck, healthCheck } from "./helpers/fake-health-check-agent";

const OK: McpToolCallOutcome = {
  status: "ok",
  content: [],
  structuredContent: null,
};

function poolAnswering(
  respond: (
    call: FakePoolCall,
  ) => McpToolCallOutcome | Promise<McpToolCallOutcome>,
) {
  const fake = createFakePool((call) => Promise.resolve(respond(call)));
  const pool = fake.factory({
    servers: {
      db: { type: "local", command: ["pg-mcp"] },
      browser: { type: "local", command: ["browser-mcp"] },
    },
    placement: { kind: "host", workspaceDir: "/repo" },
    env: {},
    signal: new AbortController().signal,
  });
  return { fake, pool };
}

describe("runDirectMcpHealthChecks", () => {
  test("calls each check's tool with its args on its server, bounded by its timeout, and passes on ok", async () => {
    const { fake, pool } = poolAnswering(() => OK);
    const signal = new AbortController().signal;

    const reports = await runDirectMcpHealthChecks({
      pool,
      healthChecks: [
        healthCheck({
          mcp: "db",
          tool: "query",
          args: { sql: "select 1" },
          timeoutSeconds: 7,
        }),
      ],
      signal,
    });

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      serverKey: "db",
      tool: "query",
      args: { sql: "select 1" },
      timeoutMs: 7000,
    });
    expect(fake.calls[0]?.signal).toBe(signal);
    expect(reports).toEqual([
      {
        name: "db_query",
        resolvedId: "db_query",
        severity: "required",
        kind: "tool",
        outcome: { kind: "passed" },
      },
    ]);
  });

  test("fails on tool_error, unavailable and timeout", async () => {
    const outcomes: Record<string, McpToolCallOutcome> = {
      a: { status: "tool_error", content: [{ type: "text", text: "denied" }] },
      b: { status: "unavailable", reason: "start", detail: "spawn failed" },
      c: { status: "timeout" },
    };
    const { pool } = poolAnswering(
      (call) => outcomes[call.tool] ?? { status: "timeout" },
    );

    const reports = await runDirectMcpHealthChecks({
      pool,
      healthChecks: [
        healthCheck({ mcp: "db", tool: "a", severity: "warn" }),
        healthCheck({ mcp: "db", tool: "b", severity: "warn" }),
        healthCheck({
          mcp: "db",
          tool: "c",
          severity: "warn",
          timeoutSeconds: 2,
        }),
      ],
      signal: new AbortController().signal,
    });

    expect(reports.map((report) => report.outcome)).toEqual([
      { kind: "failed", reason: "tool-error", detail: "denied" },
      {
        kind: "failed",
        reason: "unavailable",
        detail: "start: spawn failed",
      },
      {
        kind: "failed",
        reason: "timeout",
        detail: "The tool call did not finish within 2000ms.",
      },
    ]);
  });

  test("a required failure skips the warn phase", async () => {
    const { fake, pool } = poolAnswering((call) =>
      call.tool === "broken" ? { status: "timeout" } : OK,
    );

    const reports = await runDirectMcpHealthChecks({
      pool,
      healthChecks: [
        healthCheck({ mcp: "db", tool: "advisory", severity: "warn" }),
        healthCheck({ mcp: "db", tool: "broken" }),
      ],
      signal: new AbortController().signal,
    });

    expect(fake.calls.map((call) => call.tool)).toEqual(["broken"]);
    expect(reports.map((report) => report.outcome.kind)).toEqual([
      "skipped",
      "failed",
    ]);
  });

  test("a warn failure doesn't stop other checks", async () => {
    const { fake, pool } = poolAnswering((call) =>
      call.tool === "flaky" ? { status: "tool_error", content: [] } : OK,
    );

    const reports = await runDirectMcpHealthChecks({
      pool,
      healthChecks: [
        healthCheck({ mcp: "db", tool: "flaky", severity: "warn" }),
        healthCheck({ mcp: "db", tool: "later", severity: "warn" }),
      ],
      signal: new AbortController().signal,
    });

    expect(fake.calls).toHaveLength(2);
    expect(reports.map((report) => report.outcome.kind)).toEqual([
      "failed",
      "passed",
    ]);
  });

  test("runs required before warn and checks sharing a serialGroup one at a time", async () => {
    const events: string[] = [];
    let inFlightInGroup = 0;
    let maxInFlightInGroup = 0;
    const { pool } = poolAnswering(async (call) => {
      events.push(`start:${call.tool}`);
      const grouped = call.serverKey === "browser";
      if (grouped) {
        inFlightInGroup += 1;
        maxInFlightInGroup = Math.max(maxInFlightInGroup, inFlightInGroup);
      }
      await Promise.resolve();
      await Promise.resolve();
      if (grouped) inFlightInGroup -= 1;
      events.push(`end:${call.tool}`);
      return OK;
    });

    const reports = await runDirectMcpHealthChecks({
      pool,
      healthChecks: [
        healthCheck({ mcp: "db", tool: "warn-check", severity: "warn" }),
        healthCheck({ mcp: "browser", tool: "open", serialGroup: "browser" }),
        healthCheck({ mcp: "browser", tool: "close", serialGroup: "browser" }),
        healthCheck({ mcp: "db", tool: "ping" }),
      ],
      signal: new AbortController().signal,
    });

    expect(maxInFlightInGroup).toBe(1);
    expect(events.indexOf("end:open")).toBeLessThan(
      events.indexOf("start:close"),
    );
    expect(events.indexOf("start:warn-check")).toBeGreaterThan(
      Math.max(events.indexOf("end:close"), events.indexOf("end:ping")),
    );
    expect(reports.map((report) => report.outcome.kind)).toEqual([
      "passed",
      "passed",
      "passed",
      "passed",
    ]);
  });

  test("a call aborted by the run is skipped", async () => {
    const { pool } = poolAnswering(() => ({ status: "aborted" }));

    const reports = await runDirectMcpHealthChecks({
      pool,
      healthChecks: [healthCheck({ mcp: "db", tool: "ping" })],
      signal: new AbortController().signal,
    });

    expect(reports[0]?.outcome).toEqual({ kind: "skipped" });
  });

  test("rejects a check that isn't an MCP tool check", async () => {
    const { pool } = poolAnswering(() => OK);

    const run = runDirectMcpHealthChecks({
      pool,
      healthChecks: [cliHealthCheck({ command: ["gh", "--version"] })],
      signal: new AbortController().signal,
    });

    let message = "";
    try {
      await run;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("only MCP tool checks");
  });
});

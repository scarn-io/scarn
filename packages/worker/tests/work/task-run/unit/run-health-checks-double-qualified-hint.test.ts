import { afterEach, describe, expect, test } from "bun:test";
import { runHealthChecks } from "../../../../src/work/task-run/application/run-health-checks";
import {
  FAST_HEALTH_CHECK_INTERVALS,
  healthCheck,
  installFakeAgent,
  restoreFetch,
  startedFakeAiServer,
} from "./helpers/fake-health-check-agent";

afterEach(() => {
  restoreFetch();
});

const server = {
  baseUrl: "http://127.0.0.1:4096",
  password: "test-password",
  workspaceFolder: "/workspaces/repo",
};

const connected = (name: string) => () => [
  { name, status: { status: "connected" } },
];

/**
 * A tool name starting with its own server key is not necessarily a
 * double-qualification mistake (Microsoft's PostgreSQL MCP server's tools are
 * named `postgres_mcp_*`), so the runner always calls `${mcp}_${tool}` and
 * only suggests the bare name once that call has actually failed.
 */
describe("runHealthChecks — double-qualification hint", () => {
  test("passes a tool whose real name starts with the server key, calling it with one server prefix", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({
        mcpServers: connected("postgres"),
        toolStates: { postgres_postgres_mcp_connect: { status: "completed" } },
      });

      const result = await runHealthChecks({
        server,
        healthChecks: [
          healthCheck({ mcp: "postgres", tool: "postgres_mcp_connect" }),
        ],
        fakeAiServer,
        ...FAST_HEALTH_CHECK_INTERVALS,
      });

      expect(result[0]?.resolvedId).toBe("postgres_postgres_mcp_connect");
      expect(result[0]?.outcome).toEqual({ kind: "passed" });
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("appends the hint when a failed check's tool already starts with the server key", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({
        mcpServers: connected("playwright"),
        toolStates: {
          playwright_playwright_browser_navigate: {
            status: "error",
            error: "tool not found",
          },
        },
      });

      const result = await runHealthChecks({
        server,
        healthChecks: [
          healthCheck({
            mcp: "playwright",
            tool: "playwright_browser_navigate",
          }),
        ],
        fakeAiServer,
        ...FAST_HEALTH_CHECK_INTERVALS,
      });

      expect(result[0]?.outcome).toEqual({
        kind: "failed",
        reason: "tool-error",
        detail:
          'tool not found Hint: with mcp "playwright", tool ' +
          '"playwright_browser_navigate" was called as ' +
          '"playwright_playwright_browser_navigate". If "playwright_" was ' +
          'meant as the server prefix, set tool: "browser_navigate".',
      });
    } finally {
      await fakeAiServer.stop();
    }
  });

  test("adds no hint to a failed check whose tool doesn't start with the server key", async () => {
    const fakeAiServer = await startedFakeAiServer();
    try {
      installFakeAgent({
        mcpServers: connected("playwright"),
        toolStates: {
          playwright_browser_navigate: {
            status: "error",
            error: "browser crashed",
          },
        },
      });

      const result = await runHealthChecks({
        server,
        healthChecks: [
          healthCheck({ mcp: "playwright", tool: "browser_navigate" }),
        ],
        fakeAiServer,
        ...FAST_HEALTH_CHECK_INTERVALS,
      });

      expect(result[0]?.outcome).toEqual({
        kind: "failed",
        reason: "tool-error",
        detail: "browser crashed",
      });
    } finally {
      await fakeAiServer.stop();
    }
  });
});

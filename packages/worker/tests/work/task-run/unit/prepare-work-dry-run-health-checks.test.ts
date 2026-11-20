import { describe, expect, test } from "bun:test";
import { createScarnClient } from "@scarn/sdk";
import { healthChecksSchema } from "@scarn/sdk/health-checks";
import type { OpenCodeMcpServers } from "../../../../src/common/contracts/opencode-mcp";
import {
  managedOnlyWorkDryRunReport,
  prepareWorkDryRunHealthChecks,
} from "../../../../src/work/task-run/application/prepare-work-dry-run-health-checks";
import {
  buildReport,
  resolveHealthCheckToolId,
} from "../../../../src/work/task-run/application/run-health-checks";
import { computeDryRunOk } from "../../../../src/work/task-run/application/compute-dry-run-ok";

const managed = {
  docs: { type: "ref", name: "notion", auth: { connection: "notion" } },
  off: {
    type: "remote",
    url: "https://mcp.notion.com/mcp",
    auth: { connection: "notion" },
    disabled: true,
  },
} satisfies OpenCodeMcpServers;

function fixture(broken = false) {
  const calls: string[] = [];
  const client = createScarnClient("https://scarn.test", {
    fetch: (request) => {
      const url = new URL(
        request instanceof Request ? request.url : String(request),
      );
      calls.push(url.pathname);
      return Promise.resolve(
        Response.json(
          url.pathname.endsWith("/tools")
            ? broken
              ? { message: "Authorization: Bearer must-not-leak" }
              : { tools: [{ name: "search", inputSchema: {} }] }
            : [{ id: "connection", name: "notion", state: "ready" }],
          { status: broken && url.pathname.endsWith("/tools") ? 502 : 200 },
        ),
      );
    },
  });
  return { client, calls };
}

describe("work dry-run managed startup integration", () => {
  test.each([false, true])(
    "every enabled managed alias is probed without authored checks; broken=%p",
    async (broken) => {
      const { client, calls } = fixture(broken);
      const plan = await prepareWorkDryRunHealthChecks({
        client,
        projectId: "project",
        opencodeMcpJson: {
          ...managed,
          wiki: {
            type: "remote",
            url: "https://mcp.notion.com/mcp",
            auth: { connection: "notion" },
          },
        },
        healthChecks: [],
      });
      expect(plan.needsRuntime).toBe(false);
      expect(plan.opencodeMcpJson).toEqual({});
      expect(calls).toEqual([
        "/api/projects/project/mcp-connections",
        "/api/projects/project/mcp-connections/connection/tools",
      ]);
      const report = managedOnlyWorkDryRunReport({
        scope: { kind: "global-only" },
        ...plan.mergeReports({ mcpServers: [], healthChecks: [] }),
        note: { baseBranchNote: "default branch" },
      });
      expect(report.ok).toBe(!broken);
      expect(report.baseBranchNote).toBe("default branch");
      expect(report.mcpServers.map((server) => server.name)).toEqual([
        "docs",
        "wiki",
      ]);
      expect(report.mcpServers.every((server) => server.healthy)).toBe(!broken);
      expect(JSON.stringify(report)).not.toContain("must-not-leak");
      if (broken) {
        expect(report.mcpServers[0]?.error).toContain(
          "Reconnect it in project settings",
        );
      }
    },
  );

  test("mixed steps retain ordinary/CLI checks and merge both report lists in authored order", async () => {
    const { client } = fixture();
    const healthChecks = healthChecksSchema.parse([
      { kind: "tool", mcp: "docs", tool: "search", name: "managed-first" },
      { kind: "cli", command: ["true"], name: "cli" },
      { kind: "tool", mcp: "local", tool: "search", name: "ordinary" },
      { kind: "tool", mcp: "docs", tool: "search", name: "managed-last" },
      { kind: "tool", tool: "plugin_tool", name: "plugin" },
    ]);
    const local = { type: "local" as const, command: ["server"] };
    const plan = await prepareWorkDryRunHealthChecks({
      client,
      projectId: "project",
      opencodeMcpJson: {
        docs: managed.docs,
        local,
        off: managed.off,
      },
      healthChecks,
    });
    expect(plan.needsRuntime).toBe(true);
    expect(plan.opencodeMcpJson).toEqual({ local });
    expect(plan.runnableChecks.map((check) => check.name)).toEqual([
      "cli",
      "ordinary",
      "plugin",
    ]);
    const combined = plan.mergeReports({
      mcpServers: [
        { name: "local", status: "connected", healthy: true },
        { name: "global", status: "connected", healthy: true },
      ],
      healthChecks: plan.runnableChecks.map((check) =>
        buildReport(check, resolveHealthCheckToolId(check), { kind: "passed" }),
      ),
    });
    expect(combined.mcpServers.map((server) => server.name)).toEqual([
      "docs",
      "local",
      "global",
    ]);
    expect(combined.healthChecks.map((check) => check.name)).toEqual(
      healthChecks.map(
        (check) => check.name ?? resolveHealthCheckToolId(check),
      ),
    );
    expect(combined.healthChecks.map((check) => check.outcome.kind)).toEqual([
      "skipped",
      "passed",
      "passed",
      "skipped",
      "passed",
    ]);
    expect(
      computeDryRunOk({
        containerHealthy: true,
        opencodeHealthy: true,
        ...combined,
      }),
    ).toBe(true);
  });

  test("managed startup does not suppress ordinary server startup without checks", async () => {
    const { client } = fixture();
    const plan = await prepareWorkDryRunHealthChecks({
      client,
      projectId: "project",
      opencodeMcpJson: {
        ...managed,
        local: { type: "local", command: ["server"] },
      },
      healthChecks: [],
    });
    expect(plan.needsRuntime).toBe(true);
  });

  test("CLI checks still need a runtime and checks on disabled auth aliases are not deferred", async () => {
    const { client } = fixture();
    const healthChecks = healthChecksSchema.parse([
      { kind: "cli", command: ["true"] },
      { kind: "tool", mcp: "off", tool: "search" },
    ]);
    const plan = await prepareWorkDryRunHealthChecks({
      client,
      projectId: "project",
      opencodeMcpJson: managed,
      healthChecks,
    });
    expect(plan.opencodeMcpJson).toEqual({});
    expect(plan.needsRuntime).toBe(true);
    expect(plan.runnableChecks).toEqual(healthChecks);
  });

  test.each<[OpenCodeMcpServers | null]>([
    [null],
    [{}],
    [{ off: managed.off }],
  ])(
    "ordinary no-check rehearsal retains its runtime with %p and never probes disabled auth",
    async (opencodeMcpJson) => {
      const { client, calls } = fixture();
      const plan = await prepareWorkDryRunHealthChecks({
        client,
        projectId: "project",
        opencodeMcpJson,
        healthChecks: [],
      });
      expect(plan.needsRuntime).toBe(true);
      expect(calls).toEqual([]);
    },
  );
});

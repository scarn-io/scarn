import { describe, expect, test } from "bun:test";
import { createScarnClient } from "@scarn/sdk";
import { healthChecksSchema } from "@scarn/sdk/health-checks";
import {
  partitionManagedMcpHealthChecks,
  probeManagedMcpConnections,
} from "../../../../src/work/task-run/application/probe-managed-mcp-connections";
import {
  computePipelineHealthGateOk,
  listStepHealthCheckFindings,
  type StepHealthCheckReport,
} from "../../../../src/work/task-run/application/pipeline-health-check-report";
import { stepConnectionAuthEntries } from "../../../../src/work/task-run/application/resolve-step-env";

const entries = stepConnectionAuthEntries({
  docs: { type: "ref", name: "notion", auth: { connection: "notion" } },
  wiki: {
    type: "remote",
    url: "https://mcp.notion.com/mcp",
    auth: { connection: "notion" },
  },
  off: {
    type: "ref",
    name: "notion",
    auth: { connection: "notion" },
    disabled: true,
  },
});

function fixture(
  options: {
    state?: string;
    missing?: boolean;
    listStatus?: number;
    toolsStatus?: number;
    throws?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const client = createScarnClient("https://scarn.test", {
    fetch: (request) => {
      const url = new URL(
        request instanceof Request ? request.url : String(request),
      );
      calls.push(url.pathname);
      if (options.throws)
        return Promise.reject(new Error("Authorization: Bearer secret"));
      if (url.pathname.endsWith("/tools")) {
        return Promise.resolve(
          Response.json(
            options.toolsStatus
              ? { message: "Authorization: Bearer secret" }
              : {
                  tools: [{ name: "search", inputSchema: {} }],
                  cached: false,
                  listedAt: "",
                },
            {
              status: options.toolsStatus ?? 200,
              headers: { "x-secret": "secret" },
            },
          ),
        );
      }
      return Promise.resolve(
        Response.json(
          options.listStatus
            ? { message: "Authorization: Bearer secret" }
            : options.missing
              ? []
              : [
                  {
                    id: "connection-id",
                    name: "notion",
                    state: options.state ?? "ready",
                  },
                ],
          { status: options.listStatus ?? 200 },
        ),
      );
    },
  });
  return { client, calls };
}

function step(
  overrides: Partial<StepHealthCheckReport> = {},
): StepHealthCheckReport {
  return {
    stepDefinitionId: "id",
    stepKey: "step",
    stepName: "Step",
    runtime: "server-side",
    launchError: null,
    environmentProblems: [],
    mcpServers: [],
    healthChecks: [],
    ...overrides,
  };
}

describe("managed connection startup probe", () => {
  test("resolves provider to id, preserves enabled aliases and shares the tool listing", async () => {
    const { client, calls } = fixture();
    const report = await probeManagedMcpConnections({
      client,
      projectId: "project",
      entries,
    });
    expect(report.mcpServers).toEqual([
      { name: "docs", status: "connected", healthy: true },
      { name: "wiki", status: "connected", healthy: true },
    ]);
    expect([...report.toolNamesByServer]).toEqual([
      ["docs", ["search"]],
      ["wiki", ["search"]],
    ]);
    expect(calls).toEqual([
      "/api/projects/project/mcp-connections",
      "/api/projects/project/mcp-connections/connection-id/tools",
    ]);
  });

  test("does no IO without enabled auth entries", async () => {
    const { client, calls } = fixture();
    expect(
      (
        await probeManagedMcpConnections({
          client,
          projectId: "project",
          entries: [],
        })
      ).mcpServers,
    ).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("probes an active connection with a pending reconnect", async () => {
    const { client } = fixture({ state: "ready_with_pending_reconnect" });
    expect(
      (
        await probeManagedMcpConnections({
          client,
          projectId: "project",
          entries,
        })
      ).mcpServers.every((server) => server.healthy),
    ).toBe(true);
  });

  for (const options of [
    { missing: true },
    { state: "reconnect_required" },
    { state: "connecting" },
    { listStatus: 403 },
    { toolsStatus: 409 },
    { toolsStatus: 503 },
    { toolsStatus: 502 },
    { throws: true },
  ]) {
    test(`blocks with sanitized reconnect guidance: ${JSON.stringify(options)}`, async () => {
      const { client } = fixture(options);
      const report = await probeManagedMcpConnections({
        client,
        projectId: "project",
        entries,
      });
      expect(report.toolNamesByServer.size).toBe(0);
      expect(report.mcpServers.every((server) => !server.healthy)).toBe(true);
      expect(JSON.stringify(report.mcpServers)).not.toContain("secret");
      expect(report.mcpServers[0]?.error).toContain(
        "Reconnect it in project settings",
      );
      expect(computePipelineHealthGateOk([step(report)])).toBe(false);
    });
  }
});

describe("managed auth check finding policy", () => {
  const checks = healthChecksSchema.parse([
    { kind: "tool", mcp: "docs", tool: "search" },
    { kind: "tool", mcp: "ordinary", tool: "search" },
    { kind: "cli", command: ["true"] },
    { kind: "tool", mcp: "off", tool: "search" },
    { kind: "tool", tool: "search" },
  ]);

  test("skips only enabled auth tool checks and leaves ordinary checks untouched", () => {
    const partition = partitionManagedMcpHealthChecks({
      entries,
      healthChecks: checks,
    });
    expect(partition.runnableChecks).toEqual(checks.slice(1));
    expect(partition.skippedChecks).toEqual([
      {
        name: "docs_search",
        resolvedId: "docs_search",
        kind: "tool",
        severity: "required",
        outcome: { kind: "skipped", reason: "real-runs-only" },
      },
    ]);
    const findings = listStepHealthCheckFindings([
      step({ healthChecks: partition.skippedChecks }),
    ]);
    expect(findings[0]).toMatchObject({
      message: "runs in real runs only",
      outcome: "skipped",
      blocking: false,
    });
  });

  test("auth skip and legacy notRunnable never suppress startup or environment failures", async () => {
    const { client } = fixture({ toolsStatus: 409 });
    const probe = await probeManagedMcpConnections({
      client,
      projectId: "project",
      entries,
    });
    const { skippedChecks } = partitionManagedMcpHealthChecks({
      entries,
      healthChecks: checks,
    });
    for (const launchError of [null, "launch failed"]) {
      const report = step({
        ...probe,
        healthChecks: skippedChecks,
        notRunnable: "legacy skip",
        launchError,
      });
      expect(computePipelineHealthGateOk([report])).toBe(false);
      expect(
        listStepHealthCheckFindings([report]).filter((finding) =>
          finding.checkName.startsWith("mcp "),
        ),
      ).toHaveLength(2);
    }
    expect(
      computePipelineHealthGateOk([
        step({
          notRunnable: "legacy skip",
          environmentProblems: ["unhealthy"],
        }),
      ]),
    ).toBe(false);
  });

  test("ordinary required skips still block", () => {
    expect(
      computePipelineHealthGateOk([
        step({
          healthChecks: [
            {
              name: "ordinary",
              resolvedId: "ordinary",
              kind: "tool",
              severity: "required",
              outcome: { kind: "skipped" },
            },
          ],
        }),
      ]),
    ).toBe(false);
  });
});

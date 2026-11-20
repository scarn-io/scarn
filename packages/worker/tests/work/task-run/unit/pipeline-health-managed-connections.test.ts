import { describe, expect, test } from "bun:test";
import { createScarnClient } from "@scarn/sdk";
import { healthChecksSchema } from "@scarn/sdk/health-checks";
import type { HealthCheckStep } from "../../../../src/work/task-run/application/plan-pipeline-health-check-launches";
import { probeManagedMcpConnections } from "../../../../src/work/task-run/application/probe-managed-mcp-connections";
import {
  runPipelineHealthCheckLaunches,
  type RunHealthCheckLaunch,
} from "../../../../src/work/task-run/application/run-pipeline-health-checks-dry-run";
import { listStepHealthCheckFindings } from "../../../../src/work/task-run/application/pipeline-health-check-report";

const checks = healthChecksSchema.parse([
  { kind: "cli", name: "before", command: ["true"] },
  { kind: "tool", name: "managed", mcp: "docs", tool: "search" },
  { kind: "tool", name: "ordinary", mcp: "local", tool: "search" },
  { kind: "tool", name: "alias", mcp: "wiki", tool: "search" },
  { kind: "tool", name: "disabled", mcp: "off", tool: "search" },
  { kind: "cli", name: "after", command: ["true"] },
]);

function step(healthChecksJson = checks): HealthCheckStep {
  return {
    stepDefinitionId: "step",
    key: "step",
    name: "Step",
    environment: null,
    healthChecksJson,
    opencodeMcpJson: {
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
      local: { type: "local", command: ["server"] },
    },
  };
}

function probeFixture(options: { state?: string; toolsStatus?: number } = {}) {
  const calls: string[] = [];
  const client = createScarnClient("https://scarn.test", {
    fetch: (request) => {
      const url = new URL(
        request instanceof Request ? request.url : String(request),
      );
      calls.push(url.pathname);
      return Promise.resolve(
        url.pathname.endsWith("/tools")
          ? Response.json(
              options.toolsStatus
                ? { message: "Authorization: Bearer secret" }
                : { tools: [{ name: "search", inputSchema: {} }] },
              { status: options.toolsStatus ?? 200 },
            )
          : Response.json([
              {
                id: "connection",
                name: "notion",
                state: options.state ?? "ready",
              },
            ]),
      );
    },
  });
  return {
    calls,
    probeManaged: (
      entries: Parameters<typeof probeManagedMcpConnections>[0]["entries"],
    ) => probeManagedMcpConnections({ client, projectId: "project", entries }),
  };
}

const runLaunch: RunHealthCheckLaunch = (launch) =>
  Promise.resolve({
    kind: "ran",
    resolvedEnvironment: {
      source: "repo-default",
      runtime: { kind: "host" },
      envVars: [],
      connectors: [],
    },
    health: {
      containerHealth: null,
      opencodeHealth: { healthy: true },
      mcpServers: [
        { name: "local", status: "connected", healthy: true },
        { name: "unrelated", status: "failed", healthy: false },
      ],
    },
    healthChecksByStep: new Map(
      launch.steps.map((entry) => [
        entry.stepDefinitionId,
        (entry.healthChecksJson ?? []).map((check) => ({
          name: check.name ?? "",
          resolvedId: check.name ?? "",
          severity: check.severity,
          kind: check.kind,
          outcome: { kind: "passed" as const },
        })),
      ]),
    ),
  });

describe("pipeline managed startup integration", () => {
  test("merges mixed check results in declaration order and coalesces ordinary launches", async () => {
    const probe = probeFixture({ state: "ready_with_pending_reconnect" });
    let launches = 0;
    const result = await runPipelineHealthCheckLaunches({
      pipelineDefinitionId: "pipeline",
      steps: [step(), { ...step(), stepDefinitionId: "second", key: "second" }],
      probeManaged: probe.probeManaged,
      runLaunch: (launch) => {
        launches++;
        expect(launch.steps).toHaveLength(2);
        expect(launch.opencodeMcpJson).toEqual({
          local: { type: "local", command: ["server"] },
        });
        expect(
          launch.steps[0]?.healthChecksJson?.map((check) => check.name),
        ).toEqual(["before", "ordinary", "disabled", "after"]);
        return runLaunch(launch);
      },
    });
    expect(launches).toBe(1);
    expect(result.ok).toBe(true);
    expect(
      result.steps[0]?.healthChecks.map((check) => [
        check.name,
        check.outcome.kind,
      ]),
    ).toEqual([
      ["before", "passed"],
      ["managed", "skipped"],
      ["ordinary", "passed"],
      ["alias", "skipped"],
      ["disabled", "passed"],
      ["after", "passed"],
    ]);
    expect(result.steps[0]?.mcpServers.map((server) => server.name)).toEqual([
      "local",
      "docs",
      "wiki",
    ]);
    expect(probe.calls.filter((path) => path.endsWith("/tools"))).toHaveLength(
      2,
    );
  });

  for (const options of [
    { state: "not_connected" },
    { toolsStatus: 409 },
    { toolsStatus: 500 },
  ]) {
    test(`blocks no-check startup without launching: ${JSON.stringify(options)}`, async () => {
      const probe = probeFixture(options);
      const result = await runPipelineHealthCheckLaunches({
        pipelineDefinitionId: "pipeline",
        steps: [step([])],
        probeManaged: probe.probeManaged,
        runLaunch: () => {
          throw new Error("must not launch");
        },
      });
      expect(result.ok).toBe(false);
      expect(result.launchCount).toBe(0);
      expect(result.stepsWithoutChecks).toEqual([]);
      const findings = listStepHealthCheckFindings(result.steps);
      expect(findings).toHaveLength(2);
      expect(findings.every((finding) => finding.blocking)).toBe(true);
      expect(findings[0]?.message).toContain(
        "Reconnect it in project settings",
      );
      expect(JSON.stringify(result)).not.toContain("secret");
    });
  }

  test("managed skips cannot hide a launch failure or broken startup", async () => {
    const probe = probeFixture({ toolsStatus: 409 });
    const result = await runPipelineHealthCheckLaunches({
      pipelineDefinitionId: "pipeline",
      steps: [step()],
      probeManaged: probe.probeManaged,
      runLaunch: () =>
        Promise.resolve({ kind: "launch-failed", reason: "broken runtime" }),
    });
    expect(result.ok).toBe(false);
    expect(result.steps[0]?.healthChecks.map((check) => check.name)).toEqual([
      "managed",
      "alias",
    ]);
    expect(
      listStepHealthCheckFindings(result.steps).filter(
        (finding) => finding.blocking,
      ),
    ).toHaveLength(3);
  });
});

import { describe, expect, test } from "bun:test";
import { createScarnClient } from "@scarn/sdk";
import type { OpenCodeMcpServers } from "../../../../src/common/contracts/opencode-mcp";
import {
  planHealthCheckLaunches,
  type HealthCheckStep,
} from "../../../../src/work/task-run/application/plan-pipeline-health-check-launches";
import {
  runPipelineHealthCheckLaunches,
  type RunHealthCheckLaunch,
} from "../../../../src/work/task-run/application/run-pipeline-health-checks-dry-run";
import {
  computePipelineHealthGateOk,
  listStepHealthCheckFindings,
} from "../../../../src/work/task-run/application/pipeline-health-check-report";
import {
  stepConnectionAuthEntries,
  stepNotRunnableReason,
} from "../../../../src/work/task-run/application/resolve-step-env";
import {
  managedOnlyWorkDryRunReport,
  prepareWorkDryRunHealthChecks,
} from "../../../../src/work/task-run/application/prepare-work-dry-run-health-checks";

/**
 * Real runs use the relay for connection-authenticated MCP servers (`auth`).
 * Pipeline dry runs probe startup server-side and skip only managed tool checks.
 * Work dry runs use the same server-side startup and per-check skip policy.
 */

const NOTION = "https://mcp.notion.com/mcp";

const withNotion = {
  notion: { type: "ref", name: "notion", auth: { connection: "notion" } },
  local: { type: "local", command: ["server"] },
} satisfies OpenCodeMcpServers;

function step(
  overrides: Partial<HealthCheckStep> & { key: string },
): HealthCheckStep {
  return {
    stepDefinitionId: `id-${overrides.key}`,
    name: `Step ${overrides.key}`,
    kind: "user_defined",
    environment: null,
    opencodeMcpJson: null,
    healthChecksJson: [
      {
        kind: "cli",
        name: `${overrides.key}-check`,
        command: ["true"],
        expectExitCode: 0,
        severity: "required",
        timeoutSeconds: 15,
      },
    ],
    ...overrides,
  };
}

describe("stepConnectionAuthEntries", () => {
  test("lists enabled ref and remote entries with auth", () => {
    expect(
      stepConnectionAuthEntries({
        ...withNotion,
        inline: {
          type: "remote",
          url: NOTION,
          auth: { connection: "notion" },
        },
        off: {
          type: "remote",
          url: NOTION,
          auth: { connection: "notion" },
          disabled: true,
        },
        plain: { type: "ref", name: "postgres" },
      }),
    ).toEqual([
      { key: "notion", connection: "notion" },
      { key: "inline", connection: "notion" },
    ]);
  });

  test("is empty without MCP servers", () => {
    expect(stepConnectionAuthEntries(null)).toEqual([]);
  });

  test("names the connection in the reason", () => {
    expect(stepNotRunnableReason(withNotion)).toBe(
      "uses the project's \"notion\" connection: skipped: needs a run's managed launch",
    );
    expect(
      stepNotRunnableReason({ plain: { type: "ref", name: "postgres" } }),
    ).toBeNull();
  });
});

describe("health-check planning with connection auth", () => {
  test("coalesces ordinary checks and probes managed startup without checks", () => {
    const plan = planHealthCheckLaunches([
      step({ key: "a" }),
      step({ key: "b", opencodeMcpJson: withNotion }),
      step({ key: "c", opencodeMcpJson: withNotion, healthChecksJson: [] }),
    ]);

    expect(
      plan.launches.map((launch) => launch.steps.map((s) => s.key)),
    ).toEqual([["a", "b"]]);
    expect(plan.launches[0]?.opencodeMcpJson).toEqual({
      local: { type: "local", command: ["server"] },
    });
    expect(plan.stepsWithoutChecks).toEqual([]);
    expect(plan.managedSteps.map(({ step: entry }) => entry.key)).toEqual([
      "b",
      "c",
    ]);
  });
});

describe("run-offer gate with connection auth", () => {
  test("probes managed startup and still runs ordinary checks", async () => {
    const launches: string[][] = [];
    const runLaunch: RunHealthCheckLaunch = (launch) => {
      launches.push(launch.steps.map((entry) => entry.key));
      return Promise.resolve({
        kind: "ran",
        resolvedEnvironment: {
          source: "repo-default",
          runtime: { kind: "managed", id: "bun1" },
          envVars: [],
          connectors: [],
        },
        health: {
          containerHealth: { status: "running", healthy: true },
          opencodeHealth: { healthy: true },
          mcpServers: [],
        },
        healthChecksByStep: new Map(
          launch.steps.map((entry) => [entry.stepDefinitionId, []]),
        ),
      });
    };

    const result = await runPipelineHealthCheckLaunches({
      pipelineDefinitionId: "pipeline-1",
      steps: [
        step({ key: "notion", opencodeMcpJson: withNotion }),
        step({ key: "plain" }),
      ],
      runLaunch,
      probeManaged: () =>
        Promise.resolve({
          mcpServers: [{ name: "notion", status: "connected", healthy: true }],
          toolNamesByServer: new Map(),
        }),
    });

    expect(launches).toEqual([["notion", "plain"]]);
    expect(result.launchCount).toBe(1);
    expect(result.ok).toBe(true);
    expect(
      result.steps.map((entry) => [entry.stepKey, entry.notRunnable ?? null]),
    ).toEqual([
      ["notion", null],
      ["plain", null],
    ]);
    expect(listStepHealthCheckFindings(result.steps)).toEqual([]);
    expect(computePipelineHealthGateOk(result.steps.slice(1))).toBe(true);
  });

  test("skips managed tool checks and probes no-check startup without launching", async () => {
    const result = await runPipelineHealthCheckLaunches({
      pipelineDefinitionId: "pipeline-1",
      steps: [
        step({
          key: "notion",
          opencodeMcpJson: withNotion,
          healthChecksJson: [
            {
              kind: "tool",
              mcp: "notion",
              tool: "search",
              severity: "required",
              timeoutSeconds: 15,
            },
          ],
        }),
        step({
          key: "no-checks",
          opencodeMcpJson: withNotion,
          healthChecksJson: [],
        }),
      ],
      runLaunch: () => {
        throw new Error("Connection-auth dry runs must not launch");
      },
      probeManaged: () =>
        Promise.resolve({
          mcpServers: [{ name: "notion", status: "connected", healthy: true }],
          toolNamesByServer: new Map(),
        }),
    });

    expect(result.ok).toBe(true);
    expect(result.launchCount).toBe(0);
    expect(result.stepsWithoutChecks).toEqual([]);
    expect(listStepHealthCheckFindings(result.steps)).toHaveLength(1);
    for (const finding of listStepHealthCheckFindings(result.steps)) {
      expect(finding.outcome).toBe("skipped");
      expect(finding.blocking).toBe(false);
      expect(finding.message).toBe("runs in real runs only");
    }
    for (const report of result.steps) {
      expect(report.launchError).toBeNull();
      expect(report.environmentProblems).toEqual([]);
      expect(report.mcpServers).toEqual([
        { name: "notion", status: "connected", healthy: true },
      ]);
    }
  });
});

describe("work dry run with connection auth", () => {
  test("reports managed startup without launching or invoking a required tool check", async () => {
    const client = createScarnClient("https://scarn.test", {
      fetch: (request) =>
        Promise.resolve(
          Response.json(
            String(request instanceof Request ? request.url : request).endsWith(
              "/tools",
            )
              ? { tools: [{ name: "search", inputSchema: {} }] }
              : [{ id: "connection", name: "notion", state: "ready" }],
          ),
        ),
    });
    const checks = await prepareWorkDryRunHealthChecks({
      client,
      projectId: "project",
      opencodeMcpJson: { notion: withNotion.notion },
      healthChecks: [
        {
          kind: "tool",
          mcp: "notion",
          tool: "search",
          severity: "required",
          timeoutSeconds: 15,
        },
      ],
    });
    expect(checks.needsRuntime).toBe(false);
    expect(checks.runnableChecks).toEqual([]);
    expect(checks.opencodeMcpJson).toEqual({});
    const report = managedOnlyWorkDryRunReport({
      scope: { kind: "global-only" },
      ...checks.mergeReports({ mcpServers: [], healthChecks: [] }),
      note: {},
    });
    expect(report.ok).toBe(true);
    expect(report.notRunnable).toBeUndefined();
    expect(report.workspacePath).toBeNull();
    expect(report.runtimeContainerId).toBeNull();
    expect(report.agentBaseUrl).toBeNull();
    expect(report.kept).toBe(false);
    expect(report.containerHealth).toBeNull();
    expect(report.opencodeHealth).toBeNull();
    expect(report.launchError).toBeUndefined();
    expect(report.mcpServers).toEqual([
      { name: "notion", status: "connected", healthy: true },
    ]);
    expect(report.healthChecks[0]?.outcome).toEqual({
      kind: "skipped",
      reason: "real-runs-only",
    });
  });
});

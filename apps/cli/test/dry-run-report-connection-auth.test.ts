import { describe, expect, test } from "bun:test";
import type {
  PipelineHealthDryRunReport,
  WorkDryRunReport,
} from "@scarn/worker";
import {
  renderDryRunReport,
  toDryRunGateResult,
} from "../src/lib/dry-run-report";
import type { BaseReporter } from "../src/lib/reporter-types";

const RECONNECT =
  "The project's Notion connection is not serving. Reconnect it in project settings and try again.";

function workReport(healthy = true): WorkDryRunReport {
  return {
    ok: healthy,
    scope: {
      kind: "step",
      stepDefinitionId: "id",
      stepDefinitionKey: "docs",
      stepDefinitionName: "Docs",
      runtimeKind: null,
      devcontainerConfigPath: null,
    },
    workspacePath: null,
    runtimeContainerId: null,
    agentBaseUrl: null,
    kept: false,
    containerHealth: null,
    opencodeHealth: null,
    providerCredentials: { ok: true, detail: "not checked" },
    mcpServers: [
      healthy
        ? { name: "docs", status: "connected", healthy: true }
        : { name: "docs", status: "failed", healthy: false, error: RECONNECT },
    ],
    healthChecks: [
      {
        name: "Search docs",
        resolvedId: "docs_search",
        severity: "required",
        kind: "tool",
        outcome: { kind: "skipped", reason: "real-runs-only" },
      },
    ],
    secrets: [],
  };
}

function pipelineReport(healthy = true): PipelineHealthDryRunReport {
  const report = workReport(healthy);
  return {
    ok: report.ok,
    pipelineDefinitionId: "pipeline-1",
    launchCount: 0,
    steps: [
      {
        stepDefinitionId: "id",
        stepKey: "docs",
        stepName: "Docs",
        runtime: "repository default",
        launchError: null,
        environmentProblems: [],
        mcpServers: report.mcpServers,
        healthChecks: report.healthChecks,
      },
    ],
    stepsWithoutChecks: [],
  };
}

function createSpyReporter(calls: string[]): BaseReporter {
  return {
    start: () => {},
    finish: () => {},
    startActivity: () => ({
      update: () => {},
      succeed: () => {},
      fail: () => {},
    }),
    info: (m) => calls.push(`info:${m}`),
    success: (m) => calls.push(`success:${m}`),
    warn: (m) => calls.push(`warn:${m}`),
    error: (m) => calls.push(`error:${m}`),
  };
}

describe("dry-run reports for a step that uses a managed connection", () => {
  test("work --dry-run reports connected startup and an explicit real-runs-only tool skip", () => {
    const calls: string[] = [];
    renderDryRunReport(workReport(), createSpyReporter(calls));
    expect(calls).toEqual([
      "info:Step: Docs (docs)",
      "success:Provider credentials: not checked",
      "success:MCP docs: connected",
      'info:Health check "Search docs" (docs_search): skipped — runs in real runs only',
    ]);
  });

  test("work --dry-run preserves broken startup alongside the tool skip", () => {
    const calls: string[] = [];
    renderDryRunReport(workReport(false), createSpyReporter(calls));
    expect(calls).toContain(`error:MCP docs: failed — ${RECONNECT}`);
    expect(calls).toContain(
      'info:Health check "Search docs" (docs_search): skipped — runs in real runs only',
    );
  });

  test("a failed ordinary launch does not hide managed startup or tool skips", () => {
    const calls: string[] = [];
    renderDryRunReport(
      { ...workReport(false), launchError: "broken runtime" },
      createSpyReporter(calls),
    );
    expect(calls).toContain(
      "error:Environment failed to launch: broken runtime",
    );
    expect(calls).toContain(`error:MCP docs: failed — ${RECONNECT}`);
    expect(calls).toContain(
      'info:Health check "Search docs" (docs_search): skipped — runs in real runs only',
    );
  });

  test("ordinary skips still explain the earlier required failure", () => {
    const report = workReport();
    report.ok = false;
    report.healthChecks = report.healthChecks.map((check) => ({
      ...check,
      outcome: { kind: "skipped" },
    }));
    const calls: string[] = [];
    renderDryRunReport(report, createSpyReporter(calls));
    expect(calls).toContain(
      'warn:Health check "Search docs" (docs_search): skipped — an earlier required health check failed first',
    );
  });

  test("the run-offer gate allows a ready connection with a required tool skip", () => {
    expect(toDryRunGateResult(pipelineReport())).toEqual({
      ok: true,
      summary: "healthy",
      findings: [
        {
          stepName: "Docs",
          checkName: "Search docs",
          severity: "required",
          passed: false,
          message: "runs in real runs only",
          blocking: false,
        },
      ],
    });
  });

  test("the run-offer gate blocks broken startup with the reconnect reason, not the tool skip", () => {
    const result = toDryRunGateResult(pipelineReport(false));
    expect(result).toEqual({
      ok: false,
      summary: `Docs › mcp docs (required): not connected (failed): ${RECONNECT}`,
      findings: [
        {
          stepName: "Docs",
          checkName: "mcp docs",
          severity: "required",
          passed: false,
          message: `not connected (failed): ${RECONNECT}`,
          blocking: true,
        },
        {
          stepName: "Docs",
          checkName: "Search docs",
          severity: "required",
          passed: false,
          message: "runs in real runs only",
          blocking: false,
        },
      ],
    });
  });
});

import type { HealthCheckSeverity } from "@scarn/sdk/health-checks";
import type { HealthCheckReport } from "./run-health-checks";
import type { McpHandshakeReport } from "./poll-mcp-status";

/**
 * What the run-offer gate learned about each step of a pushed pipeline, and
 * whether that blocks the run.
 *
 * Blocking follows a real run's semantics rather than `work --dry-run`'s
 * stricter `computeDryRunOk`. A real run kills a step only on a failed
 * `required` check (`findFailedRequiredHealthCheck`). `warn` exists to be
 * advisory, and a gate that blocked on it would refuse runs the worker
 * would happily execute. So:
 *
 * - a `required` check that did not pass blocks. `skipped` counts, though it
 *   only happens after an earlier `required` failure in the same step;
 * - an environment that failed to launch, or came up with an unhealthy
 *   container or OpenCode, blocks every step it was launched for: a real run
 *   of that step would fail the same way, before any check;
 * - a step `mcps` server or connector that is not `connected` blocks: a
 *   real run's MCP startup gate (`mcp-startup-gate.ts`) stops on it;
 * - a `warn` check that did not pass is shown but does not block.
 */

export type StepHealthCheckReport = {
  stepDefinitionId: string;
  stepKey: string;
  stepName: string;
  /** Human-readable runtime the step's checks ran in (see `describeHealthCheckRuntime`). */
  runtime: string;
  /** Set when the launch these checks needed never came up; `healthChecks` is then empty. */
  launchError: string | null;
  /** Container/OpenCode problems in the launch this step shared. */
  environmentProblems: string[];
  /** MCP startup gate result for this step's `mcps` servers and connectors, in the launch it shared. */
  mcpServers: McpHandshakeReport[];
  healthChecks: HealthCheckReport[];
  /**
   * Set when the step's `baseBranch` could not be rendered without a run
   * (it uses `input` or `workItem` tokens), so the checks ran on the
   * configured or remote default branch instead.
   */
  baseBranchNote?: string | null | undefined;
};

export type StepHealthCheckFinding = {
  stepKey: string;
  stepName: string;
  /** The check's name, or `environment` / `mcp <server>` for a launch-level problem. */
  checkName: string;
  severity: HealthCheckSeverity;
  outcome: "passed" | "failed" | "skipped";
  message: string;
  blocking: boolean;
};

function checkFinding(
  step: StepHealthCheckReport,
  check: HealthCheckReport,
): StepHealthCheckFinding {
  const base = {
    stepKey: step.stepKey,
    stepName: step.stepName,
    checkName: check.name,
    severity: check.severity,
  };
  const blocks = check.severity === "required";
  switch (check.outcome.kind) {
    case "passed":
      return { ...base, outcome: "passed", message: "passed", blocking: false };
    case "failed":
      return {
        ...base,
        outcome: "failed",
        message: `[${check.outcome.reason}] ${check.outcome.detail}`,
        blocking: blocks,
      };
    case "skipped":
      return {
        ...base,
        outcome: "skipped",
        message: "not run: an earlier required check in this step failed",
        blocking: blocks,
      };
  }
}

/** Every finding for every step, in pipeline then declaration order. */
export function listStepHealthCheckFindings(
  steps: readonly StepHealthCheckReport[],
): StepHealthCheckFinding[] {
  return steps.flatMap((step) => {
    const where = { stepKey: step.stepKey, stepName: step.stepName };
    const baseBranch = step.baseBranchNote
      ? [
          {
            ...where,
            checkName: "base branch",
            severity: "warn" as const,
            outcome: "skipped" as const,
            message: step.baseBranchNote,
            blocking: false,
          },
        ]
      : [];
    if (step.launchError !== null) {
      return [
        ...baseBranch,
        {
          ...where,
          checkName: "environment",
          severity: "required" as const,
          outcome: "failed" as const,
          message: `${step.runtime} failed to launch: ${step.launchError}`,
          blocking: true,
        },
      ];
    }
    const environment = step.environmentProblems.map((problem) => ({
      ...where,
      checkName: "environment",
      severity: "required" as const,
      outcome: "failed" as const,
      message: `${step.runtime}: ${problem}`,
      blocking: true,
    }));
    const handshakes = step.mcpServers
      .filter((server) => !server.healthy)
      .map((server) => ({
        ...where,
        checkName: `mcp ${server.name}`,
        severity: "required" as const,
        outcome: "failed" as const,
        message: `not connected (${server.status})${server.error ? `: ${server.error}` : ""}`,
        blocking: true,
      }));
    return [
      ...baseBranch,
      ...environment,
      ...handshakes,
      ...step.healthChecks.map((check) => checkFinding(step, check)),
    ];
  });
}

/** True unless some finding blocks the run; see the module doc. */
export function computePipelineHealthGateOk(
  steps: readonly StepHealthCheckReport[],
): boolean {
  return listStepHealthCheckFindings(steps).every(
    (finding) => !finding.blocking,
  );
}

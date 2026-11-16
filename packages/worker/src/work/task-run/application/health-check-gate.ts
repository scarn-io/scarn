/**
 * The real-execution health check gate (#120): starts the fake-AI harness a
 * health-check-declaring step's forced tool calls run through, and runs
 * those declared checks (#119) against the launched environment, throwing
 * before the agent is ever prompted if a `required` one fails.
 *
 * Also sequences the MCP startup gate (`mcp-startup-gate.ts`) ahead of the
 * declared checks — see {@link runLaunchGatesOrThrow}.
 *
 * Split out of `process-claimed-task-run.ts` to keep that module under
 * the repo's per-file line limit; it is the only caller.
 */
import type { HealthCheck } from "@scarn/sdk/health-checks";
import type {
  LaunchedRuntime,
  OpencodeServerHandle,
  ProjectWorkLogger,
} from "../contracts/process-project-work-types";
import { toOpencodeServerHandle } from "../../../runtime/runtime-service/infra/opencode-server-contract";
import type { WorkReporter } from "../contracts/work-reporter";
import { buildFakeAiProviderOverride, FakeAiServer } from "../infra/fake-ai";
import { HealthCheckFailedError } from "./health-check-failed-error";
import {
  describeFailedHealthCheck,
  findFailedRequiredHealthCheck,
  runHealthChecks,
  type HealthCheckReport,
  type RunHealthChecksInput,
} from "./run-health-checks";
import {
  mcpStartupGateServers,
  runMcpStartupGateOrThrow,
  type McpStartupGateOptions,
} from "./mcp-startup-gate";

/**
 * Starts the fake-AI harness for a step that declares `healthChecks`,
 * returning the started server plus the `fakeAiProviderOverride` to bake
 * into the runtime launch (see `buildFakeAiProviderOverride`, the same
 * host/port logic `run-work-dry-run.ts`'s dry-run equivalent uses). A step
 * declaring none gets `undefined` for both — no harness starts, no
 * synthetic provider is registered, and the launch stays byte-identical to
 * today.
 */
export async function startHealthCheckHarnessIfDeclared(input: {
  healthChecks: HealthCheck[];
  isNoWorkspace: boolean;
  createFakeAiServer?: (() => FakeAiServer) | undefined;
}): Promise<{
  fakeAiServer: FakeAiServer | undefined;
  fakeAiProviderOverride: { baseUrl: string } | undefined;
}> {
  if (input.healthChecks.length === 0) {
    return { fakeAiServer: undefined, fakeAiProviderOverride: undefined };
  }

  const fakeAiServer = (
    input.createFakeAiServer ?? (() => new FakeAiServer())
  )();
  await fakeAiServer.start();
  return {
    fakeAiServer,
    fakeAiProviderOverride: buildFakeAiProviderOverride({
      fakeAiServer,
      isNoWorkspace: input.isNoWorkspace,
    }),
  };
}

/**
 * Runs a step's declared health checks against the launched environment and
 * throws {@link HealthCheckFailedError} if any `required` check failed. Runs
 * after the MCP startup gate (`mcp-startup-gate.ts`), so every step MCP server
 * is already connected. The harness is stopped in a `finally` so it happens
 * exactly once, immediately after the checks complete, regardless of outcome
 * — before the caller's `fakeAiServer` reference needs to be considered
 * "live" again. The forced call's announcement and the tool's output land in
 * the durable log feed for free: the caller attaches the in-container
 * OpenCode log tail before this gate ever runs.
 */
export async function runDeclaredHealthChecksOrThrow(input: {
  fakeAiServer: FakeAiServer;
  server: OpencodeServerHandle;
  healthChecks: HealthCheck[];
  runHealthChecksOverride?:
    ((input: RunHealthChecksInput) => Promise<HealthCheckReport[]>) | undefined;
  logger: ProjectWorkLogger;
  reporter: WorkReporter;
  taskRunId: string;
}): Promise<void> {
  input.reporter.event({
    type: "task:health-checks-running",
    taskRunId: input.taskRunId,
  });
  input.logger.log("step", "Running declared health checks", {
    taskRunId: input.taskRunId,
    healthCheckCount: input.healthChecks.length,
  });

  let reports: HealthCheckReport[];
  try {
    reports = await (input.runHealthChecksOverride ?? runHealthChecks)({
      server: input.server,
      healthChecks: input.healthChecks,
      fakeAiServer: input.fakeAiServer,
    });
  } finally {
    await input.fakeAiServer.stop();
  }

  input.logger.log("step", "Declared health checks completed", {
    taskRunId: input.taskRunId,
    reports,
  });

  const requiredFailure = findFailedRequiredHealthCheck(reports);
  if (requiredFailure) {
    throw new HealthCheckFailedError(
      describeFailedHealthCheck(
        requiredFailure.report,
        requiredFailure.outcome,
      ),
    );
  }
}

/**
 * Runs the launch gates in order, before the first prompt: the MCP startup
 * gate (decision 10) for every agent step — whether or not it declares
 * `healthChecks` — then the declared health checks when the harness was
 * started. `fakeAiServer` is stopped on every path, including when the MCP
 * gate throws before the checks run.
 */
export async function runLaunchGatesOrThrow(input: {
  usesAgent: boolean;
  environment: LaunchedRuntime;
  stepMcpServerKeys: readonly string[];
  mcpStartupGate: McpStartupGateOptions | undefined;
  fakeAiServer: FakeAiServer | undefined;
  healthChecks: HealthCheck[];
  runHealthChecksOverride:
    ((input: RunHealthChecksInput) => Promise<HealthCheckReport[]>) | undefined;
  logger: ProjectWorkLogger;
  reporter: WorkReporter;
  taskRunId: string;
}): Promise<void> {
  const { environment, fakeAiServer } = input;
  const agent = environment.agent;
  try {
    if (input.usesAgent && agent) {
      await runMcpStartupGateOrThrow({
        server: toOpencodeServerHandle(agent, environment.workspaceFolder),
        expectedServers: mcpStartupGateServers({
          stepMcpServerKeys: input.stepMcpServerKeys,
          connectors: environment.resolvedEnvironment.connectors,
        }),
        options: input.mcpStartupGate,
        logger: input.logger,
        taskRunId: input.taskRunId,
      });
    }
  } catch (error) {
    await fakeAiServer?.stop();
    throw error;
  }

  if (!fakeAiServer) {
    return;
  }
  if (!agent) {
    await fakeAiServer.stop();
    throw new Error(
      "Health checks require a running agent, but the runtime environment launched without one",
    );
  }
  // A gate, not a race — see `run-health-checks.ts` for why checks are not
  // run concurrently with the agent. The forced call's announcement and the
  // tool's output land in the durable log feed: the caller attaches the
  // OpenCode log tail before the gates run.
  await runDeclaredHealthChecksOrThrow({
    fakeAiServer,
    server: toOpencodeServerHandle(agent, environment.workspaceFolder),
    healthChecks: input.healthChecks,
    runHealthChecksOverride: input.runHealthChecksOverride,
    logger: input.logger,
    reporter: input.reporter,
    taskRunId: input.taskRunId,
  });
}

/**
 * How a dry run runs one step's declared health checks, shared by `work
 * --dry-run` and the run-offer gate. An agent step's checks are forced tool
 * calls through OpenCode and the fake-AI harness (`run-health-checks.ts`). A
 * code step launches no agent, as in a real run, and its `defineMcp` checks are
 * direct MCP tool calls through a connection pool over the launch's
 * `mcpCalls` (`run-direct-mcp-health-checks.ts`, ADR 0016 decision 8).
 */
import type { HealthCheck } from "@scarn/sdk/health-checks";
import type { OpencodeServerHandle } from "../../../runtime/runtime-service/infra/opencode-server-contract";
import type { LaunchedRuntime } from "../contracts/process-project-work-types";
import { buildFakeAiProviderOverride, FakeAiServer } from "../infra/fake-ai";
import { createSdkMcpConnectionPool } from "../infra/sdk-mcp-connection-pool";
import type { McpConnectionPoolFactory } from "./mcp-connection-pool";
import { runDirectMcpHealthChecks } from "./run-direct-mcp-health-checks";
import { runHealthChecks, type HealthCheckReport } from "./run-health-checks";
import type { DryRunLaunchInput } from "./dry-run-environment";

/** A step definition's `kind`, as the API returns it. */
export type DryRunStepKind = "built_in" | "user_defined" | "code" | "mcp_tool";

/** Whether a dry run of a step of this kind launches an agent: all but code steps. */
export function dryRunStepUsesAgent(kind: DryRunStepKind | undefined): boolean {
  return kind !== "code";
}

/**
 * The launch fields that decide whether OpenCode starts: with the harness for
 * an agent launch, or none for a code step's (`fakeAiServer` null), which
 * then gets its MCP servers as `mcpCalls`.
 */
export function dryRunAgentLaunchFields(
  fakeAiServer: FakeAiServer | null,
): Pick<
  DryRunLaunchInput,
  "startAgent" | "taskKind" | "resolveFakeAiProviderOverride"
> {
  if (!fakeAiServer) return { startAgent: false, taskKind: "code" };
  return {
    startAgent: true,
    resolveFakeAiProviderOverride: (environment) =>
      buildFakeAiProviderOverride({
        fakeAiServer,
        isNoWorkspace: environment.runtime.kind === "host",
      }),
  };
}

/**
 * A fake-AI server started on first use, so a dry run that launches only code
 * steps starts none. `stop` is a no-op when it never started.
 */
export function createLazyFakeAiServer(
  create: () => FakeAiServer = () => new FakeAiServer(),
): { get(): Promise<FakeAiServer>; stop(): Promise<void> } {
  let started: Promise<FakeAiServer> | null = null;
  return {
    get() {
      started ??= (async () => {
        const server = create();
        await server.start();
        return server;
      })();
      return started;
    },
    async stop() {
      if (started) await (await started).stop();
    },
  };
}

/**
 * Runs `healthChecks` against a launched dry-run environment: through
 * OpenCode when it has an agent (`server` set), otherwise directly through a
 * pool over `environment.mcpCalls`.
 */
export async function runDryRunStepChecks(input: {
  server: OpencodeServerHandle | null;
  environment: LaunchedRuntime;
  healthChecks: HealthCheck[];
  fakeAiServer: FakeAiServer | null;
  /** Defaults to {@link createSdkMcpConnectionPool}. */
  poolFactory?: McpConnectionPoolFactory | undefined;
  /** Defaults to one that never aborts: a dry run is not cancelled mid-check. */
  signal?: AbortSignal | undefined;
}): Promise<HealthCheckReport[]> {
  if (!input.server) {
    return runCodeStepDryRunChecks({
      environment: input.environment,
      healthChecks: input.healthChecks,
      poolFactory: input.poolFactory ?? createSdkMcpConnectionPool,
      signal: input.signal ?? new AbortController().signal,
    });
  }
  if (!input.fakeAiServer) {
    throw new Error(
      "An agent step's dry-run health checks need the fake AI server",
    );
  }
  return runHealthChecks({
    server: input.server,
    healthChecks: input.healthChecks,
    fakeAiServer: input.fakeAiServer,
  });
}

/**
 * A code step's checks: one pool per call over the launch's `mcpCalls`,
 * closed once the checks finish, whatever their outcome.
 */
export async function runCodeStepDryRunChecks(input: {
  environment: LaunchedRuntime;
  healthChecks: readonly HealthCheck[];
  poolFactory: McpConnectionPoolFactory;
  signal: AbortSignal;
}): Promise<HealthCheckReport[]> {
  if (input.healthChecks.length === 0) return [];
  const { mcpCalls } = input.environment;
  if (!mcpCalls) {
    throw new Error(
      "A code step's health checks need its MCP servers, but the dry-run launch resolved none",
    );
  }
  const pool = input.poolFactory({
    servers: mcpCalls.servers,
    env: mcpCalls.env,
    placement: mcpCalls.placement,
    signal: input.signal,
  });
  try {
    return await runDirectMcpHealthChecks({
      pool,
      healthChecks: input.healthChecks,
      signal: input.signal,
    });
  } finally {
    await pool.closeAll();
  }
}

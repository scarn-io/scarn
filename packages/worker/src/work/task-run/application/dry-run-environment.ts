import {
  toOpencodeServerHandle,
  type OpencodeServerHandle,
} from "../../../runtime/runtime-service/infra/opencode-server-contract";
import type { ResolvedEnvironment } from "@scarn/sdk/environment";
import type {
  LaunchedRuntime,
  LaunchedRuntimeOrchestrator,
} from "../contracts/process-project-work-types";
import {
  checkOpencodeHealth,
  type McpHandshakeReport,
} from "./run-work-dry-run-health-checks";
import { checkMcpStartupGate, mcpStartupGateServers } from "./mcp-startup-gate";
import { logWorkError } from "./work-logger";

/**
 * One dry-run launch: bring an environment up, probe it, hand it to `run`,
 * then tear it down. Shared by `work --dry-run` (one step, or global-only) and
 * the run-offer gate (every step's health checks, one launch per runtime), so
 * both rehearse the same launch path and neither can leak a container:
 * teardown runs in a `finally`, whatever `run` or the probe does, unless the
 * caller asked to keep it.
 *
 * A launch with `startAgent: false` (a code step, ADR 0016 decision 8) has no
 * OpenCode to probe: `run` gets no server and the environment's `mcpCalls`.
 */

export type DryRunEnvironmentHealth = {
  containerHealth: { status: string; healthy: boolean } | null;
  /** Null for a launch without an agent: there is no OpenCode to check. */
  opencodeHealth: { healthy: boolean; detail?: string | undefined } | null;
  /**
   * The MCP startup gate's result per step `mcps` server and connector.
   * Empty without an agent: the gate asks OpenCode, and a code step's checks
   * call its servers directly instead.
   */
  mcpServers: McpHandshakeReport[];
};

export type DryRunLaunchInput = Parameters<
  LaunchedRuntimeOrchestrator["launch"]
>[0];

export type DryRunEnvironmentOutcome<T> =
  | { kind: "launch-failed"; reason: string }
  | {
      kind: "ran";
      resolvedEnvironment: ResolvedEnvironment;
      health: DryRunEnvironmentHealth;
      result: T;
      workspacePath: string;
      runtimeContainerId: string | null;
      agentBaseUrl: string | null;
      kept: boolean;
    };

export type ProbeDryRunEnvironment = (input: {
  environment: LaunchedRuntime;
  /** Null for a launch without an agent. */
  agent: { server: OpencodeServerHandle; version: string } | null;
  /** The MCP startup gate's servers: the step `mcps` keys plus connectors. */
  mcpServerNames: readonly string[];
}) => Promise<DryRunEnvironmentHealth>;

export const probeDryRunEnvironment: ProbeDryRunEnvironment = async ({
  environment,
  agent,
  mcpServerNames,
}) => {
  const containerHealth =
    environment.runtimeContainerId && environment.checkContainerHealth
      ? await environment.checkContainerHealth().then((result) => ({
          status: result.runtimeContainerStatus,
          healthy: ["healthy", "running"].includes(
            result.runtimeContainerStatus,
          ),
        }))
      : null;
  if (!agent) {
    return { containerHealth, opencodeHealth: null, mcpServers: [] };
  }
  const opencodeHealth = await checkOpencodeHealth(agent.server, agent.version);
  const mcpServers = await checkMcpStartupGate(agent.server, mcpServerNames);
  return { containerHealth, opencodeHealth, mcpServers };
};

// eslint-disable-next-line local/no-unknown-parameter-type -- narrows a caught value, not a real input boundary
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runInDryRunEnvironment<T>(input: {
  orchestrator: LaunchedRuntimeOrchestrator;
  launchInput: DryRunLaunchInput;
  /** Preserve the environment instead of tearing it down (`--keep`). */
  keep: boolean;
  /** Called once the environment is up, before it is probed. */
  onLaunched?: (() => void) | undefined;
  /** `server` is null exactly when the launch started no agent. */
  run: (
    server: OpencodeServerHandle | null,
    environment: LaunchedRuntime,
  ) => Promise<T>;
  probe?: ProbeDryRunEnvironment | undefined;
}): Promise<DryRunEnvironmentOutcome<T>> {
  let environment: LaunchedRuntime;
  try {
    environment = await input.orchestrator.launch(input.launchInput);
  } catch (error) {
    return { kind: "launch-failed", reason: errorMessage(error) };
  }

  try {
    input.onLaunched?.();
    const { agent } = environment;
    if (input.launchInput.startAgent && !agent) {
      throw new Error(
        "Dry-run runtime environment launched without an agent although one was requested",
      );
    }
    const server = agent
      ? toOpencodeServerHandle(agent, environment.workspaceFolder)
      : null;
    const health = await (input.probe ?? probeDryRunEnvironment)({
      environment,
      agent: agent && server ? { server, version: agent.version } : null,
      mcpServerNames: mcpStartupGateServers({
        stepMcpServerKeys: Object.keys(input.launchInput.opencodeMcpJson ?? {}),
        connectors: environment.resolvedEnvironment.connectors,
      }),
    });
    const result = await input.run(server, environment);
    return {
      kind: "ran",
      resolvedEnvironment: environment.resolvedEnvironment,
      health,
      result,
      workspacePath: environment.workspacePath,
      runtimeContainerId: environment.runtimeContainerId,
      agentBaseUrl: agent?.baseUrl ?? null,
      kept: input.keep,
    };
  } finally {
    if (!input.keep) {
      // eslint-disable-next-line local/no-unknown-parameter-type -- narrows a caught value, not a real input boundary
      await environment.cleanup().catch((error: unknown) => {
        logWorkError("dry-run", "Failed to tear down the dry-run environment", {
          runtimeContainerId: environment.runtimeContainerId,
          error: errorMessage(error),
        });
      });
    }
  }
}

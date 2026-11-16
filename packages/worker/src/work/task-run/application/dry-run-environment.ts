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
 * One dry-run launch: bring an environment up, probe it, hand the running
 * agent to `run`, then tear it down. Shared by `work --dry-run` (one step, or
 * global-only) and the run-offer gate (every step's health checks, one launch
 * per runtime), so both rehearse the same launch path and neither can leak a
 * container: teardown runs in a `finally`, whatever `run` or the probe does,
 * unless the caller asked to keep it.
 */

export type DryRunEnvironmentHealth = {
  containerHealth: { status: string; healthy: boolean } | null;
  opencodeHealth: { healthy: boolean; detail?: string | undefined };
  /** The MCP startup gate's result per step `mcps` server and connector. */
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
      agentBaseUrl: string;
      kept: boolean;
    };

export type ProbeDryRunEnvironment = (input: {
  environment: LaunchedRuntime;
  server: OpencodeServerHandle;
  agentVersion: string;
  /** The MCP startup gate's servers: the step `mcps` keys plus connectors. */
  mcpServerNames: readonly string[];
}) => Promise<DryRunEnvironmentHealth>;

export const probeDryRunEnvironment: ProbeDryRunEnvironment = async ({
  environment,
  server,
  agentVersion,
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
  const opencodeHealth = await checkOpencodeHealth(server, agentVersion);
  const mcpServers = await checkMcpStartupGate(server, mcpServerNames);
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
  run: (
    server: OpencodeServerHandle,
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
    if (!agent) {
      throw new Error(
        "Dry-run runtime environment launched without an agent although one was requested",
      );
    }
    const server = toOpencodeServerHandle(agent, environment.workspaceFolder);
    const health = await (input.probe ?? probeDryRunEnvironment)({
      environment,
      server,
      agentVersion: agent.version,
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
      agentBaseUrl: agent.baseUrl,
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

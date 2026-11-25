import { readFile } from "node:fs/promises";
import path from "node:path";
import { basicCredentialSecretValues } from "../../../common/infra/mcp-transport";
import { ConfigurationError } from "../../../lib/errors";
import {
  HOST_GATEWAY_RUN_ARGS,
  patchDevcontainerRunArgs,
} from "../../../runtime/runtime-service/infra/devcontainer-mount-injection";
import { parseDevcontainerConfigContent } from "../../../runtime/runtime-service/infra/local-devcontainer-jsonc";
import type { McpToolCallPlacement } from "../application/mcp-tool-caller";
import type {
  McpEnvRef,
  ResolvedStepEnv,
} from "../application/resolve-step-env";
import type { RegisterLaunchServers } from "../contracts/managed-launch-types";
import type { McpCallLaunch } from "../contracts/launched-runtime-handles";
import type { LaunchedRuntime } from "../contracts/launched-runtime";
import type { LaunchedRuntimeOrchestrator } from "../contracts/process-project-work-types";
import type { TaskKind } from "../contracts/task-run-contracts";
import { hasProjectWorkItemGrant } from "../application/code-step-work-item-grants";
import {
  applyStepMcpEnv,
  planStepMcpServers,
} from "./resolve-launch-mcp-servers";

type LaunchInput = Parameters<LaunchedRuntimeOrchestrator["launch"]>[0];

/**
 * A resolved step whose worker calls its MCP servers (an `mcp_tool` step, or
 * a code step with `mcps`), waiting only for its runtime's placement.
 */
export type McpCallLaunchPlan = {
  /** The relay capabilities and inferred secret values, for the log masker. */
  secretValues: string[];
  place(placement: McpToolCallPlacement): McpCallLaunch;
};

/** The task kinds whose worker calls the step's MCP servers itself. */
export type McpCallingTaskKind = "mcp_tool" | "code";

/**
 * Resolves the MCP servers of a step the worker calls them for the way an
 * agent launch does (refs, connectors, managed relay, inferred env) without
 * starting OpenCode. Runs before the container starts, so a missing ref or
 * variable, or a managed connection that isn't ready, fails the launch first.
 *
 * Keeps only the step's own servers (`opencodeMcpJson`'s keys): the
 * repository servers the plan disables for OpenCode, and the environment's
 * connectors, are not the step's to call.
 *
 * A step with no server of its own fails. A code step without servers never
 * gets here: it needs no bridge (see {@link declaresMcpServers}).
 */
export async function planMcpCallLaunch(input: {
  kind: McpCallingTaskKind;
  launch: Pick<LaunchInput, "sessionId" | "opencodeMcpJson">;
  workspacePath: string;
  connectors: readonly string[] | undefined;
  stepEnv: Readonly<Record<string, string>> | undefined;
  resolveMcpEnv: ((refs: readonly McpEnvRef[]) => ResolvedStepEnv) | undefined;
  registerManagedLaunch: RegisterLaunchServers | undefined;
}): Promise<McpCallLaunchPlan> {
  const { sessionId, opencodeMcpJson } = input.launch;
  const launch = applyStepMcpEnv({
    plan: await planStepMcpServers({
      servers: opencodeMcpJson,
      connectors: input.connectors,
      workspacePath: input.workspacePath,
      sessionId,
      registerManagedLaunch: input.registerManagedLaunch,
    }),
    stepEnv: input.stepEnv,
    resolveMcpEnv: input.resolveMcpEnv,
  });
  const servers = Object.fromEntries(
    Object.keys(opencodeMcpJson ?? {}).flatMap((key) => {
      const server = launch.servers?.[key];
      return server ? [[key, server] as const] : [];
    }),
  );
  if (Object.keys(servers).length === 0) {
    throw new Error(
      input.kind === "mcp_tool"
        ? "The MCP tool step has no MCP server to call."
        : "The code step's MCP servers resolved to no server to call.",
    );
  }
  const env = { ...launch.stepEnv };
  return {
    secretValues: [
      ...launch.secretValues,
      ...basicCredentialSecretValues(servers, env),
    ],
    place: (placement) => ({ servers, env, placement }),
  };
}

/** Whether the launch's step declares MCP servers of its own. */
export function declaresMcpServers(
  servers: LaunchInput["opencodeMcpJson"],
): boolean {
  return Object.keys(servers ?? {}).length > 0;
}

/**
 * The kind of MCP calls the worker makes for a launch that starts no agent:
 * an `mcp_tool` step's one tool call, or the MCP bridge of a code step that
 * declares MCP servers. `null` when the worker calls none.
 */
export function launchMcpCallingKind(
  input: Pick<LaunchInput, "startAgent" | "opencodeMcpJson">,
  kind: TaskKind,
): McpCallingTaskKind | null {
  if (input.startAgent) return null;
  if (kind === "mcp_tool") return "mcp_tool";
  if (kind === "code" && declaresMcpServers(input.opencodeMcpJson)) {
    return "code";
  }
  return null;
}

/**
 * Whether a launch's code step talks to a step bridge on the worker host: it
 * declares MCP servers or holds a `project` work-item grant (ADR 0018). Its
 * container then needs {@link prepareMcpBridgeDevcontainer}.
 */
export function launchServesStepBridge(
  input: Pick<
    LaunchInput,
    "startAgent" | "opencodeMcpJson" | "currentExecutionInfo"
  >,
  kind: TaskKind,
): boolean {
  if (input.startAgent || kind !== "code") return false;
  return (
    declaresMcpServers(input.opencodeMcpJson) ||
    hasProjectWorkItemGrant(input.currentExecutionInfo.grants)
  );
}

/**
 * The `LaunchedRuntime` field an MCP call launch is handed down in:
 * `mcpTool` for an `mcp_tool` step, `mcpCalls` for a code step's MCP bridge.
 */
export function mcpCallLaunchFields(
  kind: McpCallingTaskKind | null,
  launch: McpCallLaunch | undefined,
): Pick<LaunchedRuntime, "mcpTool" | "mcpCalls"> {
  if (!launch) return {};
  return kind === "mcp_tool" ? { mcpTool: launch } : { mcpCalls: launch };
}

/**
 * Lets a code step's container reach its step bridge on the worker host at
 * `host.docker.internal`: patches {@link HOST_GATEWAY_RUN_ARGS} into the
 * cloned devcontainer config before `devcontainer up`. A compose-based
 * devcontainer ignores `runArgs`, so it fails with a {@link ConfigurationError}
 * (ADR 0016, decision 9).
 */
export async function prepareMcpBridgeDevcontainer(input: {
  workspacePath: string;
  devcontainerConfigPath: string;
}): Promise<void> {
  const raw = await readFile(
    path.join(input.workspacePath, input.devcontainerConfigPath),
    "utf8",
  );
  const parsed = parseDevcontainerConfigContent(raw) as Record<string, unknown>;
  if ("dockerComposeFile" in parsed) {
    throw new ConfigurationError(
      "compose devcontainers aren't supported for code steps with `mcps` or work-item features yet. " +
        "Use an `image` or Dockerfile (`build`) devcontainer, or a managed runtime.",
      "DEVCONTAINER_COMPOSE_MCP_BRIDGE_UNSUPPORTED",
    );
  }
  await patchDevcontainerRunArgs(
    input.workspacePath,
    input.devcontainerConfigPath,
    HOST_GATEWAY_RUN_ARGS,
  );
}

import type { McpToolCallPlacement } from "../application/mcp-tool-caller";
import type {
  McpEnvRef,
  ResolvedStepEnv,
} from "../application/resolve-step-env";
import type { RegisterLaunchServers } from "../contracts/managed-launch-types";
import type { McpToolLaunch } from "../contracts/launched-runtime-handles";
import type { LaunchedRuntimeOrchestrator } from "../contracts/process-project-work-types";
import {
  applyStepMcpEnv,
  planStepMcpServers,
} from "./resolve-launch-mcp-servers";

type LaunchInput = Parameters<LaunchedRuntimeOrchestrator["launch"]>[0];

/** A resolved `mcp_tool` step, waiting only for its runtime's placement. */
export type McpToolLaunchPlan = {
  /** The relay capabilities and inferred secret values, for the log masker. */
  secretValues: string[];
  place(placement: McpToolCallPlacement): McpToolLaunch;
};

/**
 * Resolves an `mcp_tool` step's MCP servers the way an agent launch does
 * (refs, connectors, managed relay, inferred env) without starting OpenCode.
 * Runs before the container starts, so a missing ref or variable, a managed
 * connection that isn't ready, or a step with no server of its own fails the
 * launch first.
 *
 * Keeps only the step's own servers (`opencodeMcpJson`'s keys): the
 * repository servers the plan disables for OpenCode, and the environment's
 * connectors, are not the step's to call.
 */
export async function planMcpToolLaunch(input: {
  launch: Pick<LaunchInput, "sessionId" | "opencodeMcpJson">;
  workspacePath: string;
  connectors: readonly string[] | undefined;
  stepEnv: Readonly<Record<string, string>> | undefined;
  resolveMcpEnv: ((refs: readonly McpEnvRef[]) => ResolvedStepEnv) | undefined;
  registerManagedLaunch: RegisterLaunchServers | undefined;
}): Promise<McpToolLaunchPlan> {
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
    throw new Error("The MCP tool step has no MCP server to call.");
  }
  const env = { ...launch.stepEnv };
  return {
    secretValues: launch.secretValues,
    place: (placement) => ({ servers, env, placement }),
  };
}

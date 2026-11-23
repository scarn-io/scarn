import { stat } from "node:fs/promises";
import path from "node:path";
import { BrokenDevcontainerReference } from "@scarn/sdk/environment";
import {
  resolveEnvironmentDefinition,
  type EnvironmentDefinition,
} from "@scarn/sdk/resolve-environment";
import type { LaunchedRuntimeOrchestrator } from "../contracts/process-project-work-types";
import type { TaskKind } from "../contracts/task-run-contracts";
import {
  taskKindInstallsPipelineBuilder,
  taskKindResolvesMcpServers,
} from "../application/task-kind-runtime";
import { declaresMcpServers } from "./local-mcp-call-launch";

type LaunchInput = Parameters<LaunchedRuntimeOrchestrator["launch"]>[0];

/**
 * The launch's task kind. Launches that don't name one (dry runs) fall back
 * to `startAgent`: an agent when it starts one, otherwise a code step.
 */
export function launchTaskKind(input: LaunchInput): TaskKind {
  return input.taskKind ?? (input.startAgent ? "agent" : "code");
}

/**
 * What a launch sets up besides the runtime: whether it resolves the step's
 * MCP servers (agents, MCP tool steps, and code steps that declare servers)
 * and whether a managed runtime installs the pipeline-builder dependencies
 * (code steps only).
 */
export function launchPlan(input: LaunchInput): {
  kind: TaskKind;
  resolveMcpServers: boolean;
  installPipelineBuilder: boolean;
} {
  const kind = launchTaskKind(input);
  return {
    kind,
    resolveMcpServers:
      input.startAgent ||
      (taskKindResolvesMcpServers(kind) &&
        (kind !== "code" || declaresMcpServers(input.opencodeMcpJson))),
    installPipelineBuilder:
      !input.startAgent && taskKindInstallsPipelineBuilder(kind),
  };
}

export async function devcontainerExists(
  workspacePath: string,
  configPath: string,
): Promise<boolean> {
  try {
    await stat(path.join(workspacePath, configPath));
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

/** Resolves the checked-out launch configuration before any runtime starts. */
export async function resolveLaunchEnvironment(
  input: LaunchInput,
  workspacePath: string,
  lookupBranch: string,
  definition: EnvironmentDefinition,
) {
  const resolvedEnvironment = await resolveEnvironmentDefinition(
    {
      devcontainerExists: (configPath) =>
        devcontainerExists(workspacePath, configPath),
    },
    definition,
  );
  if (resolvedEnvironment instanceof Error) {
    if (resolvedEnvironment instanceof BrokenDevcontainerReference) {
      resolvedEnvironment.message += ` (branch "${lookupBranch}")`;
    }
    throw resolvedEnvironment;
  }
  if (
    resolvedEnvironment.runtime.kind === "host" &&
    input.taskKind === "code"
  ) {
    throw new Error(
      `Code step "${input.stepKey ?? ""}" cannot use the host runtime.`,
    );
  }
  const envPlan = await input.resolveEnvironmentEnv?.(resolvedEnvironment);
  const { resolveMcpServers } = launchPlan(input);
  if (!resolveMcpServers) envPlan?.resolveMcpEnv?.([]);
  const resolveMcp = envPlan?.resolveMcpEnv ?? input.resolveMcpEnv;
  const resolveMcpEnv: typeof resolveMcp = resolveMcp
    ? (refs) => {
        const resolved = resolveMcp(refs);
        input.onSecretValues?.(resolved.secretValues);
        return resolved;
      }
    : undefined;
  if (envPlan) input.onSecretValues?.(envPlan.resolved.secretValues);
  if (
    input.environment === null ||
    (input.environment.kind === "inline" && !input.environment.runtime)
  ) {
    input.logger?.log(
      "runtime",
      resolvedEnvironment.runtime.kind === "devcontainer"
        ? `Repo default picked devcontainer (${resolvedEnvironment.runtime.config}): config found on lookup branch "${lookupBranch}".`
        : `Repo default picked bun1: neither .devcontainer/devcontainer.json nor devcontainer.json exists on lookup branch "${lookupBranch}".`,
    );
  }
  return {
    resolvedEnvironment,
    resolveMcpServers,
    stepEnv: envPlan?.resolved.stepEnv ?? input.stepEnv,
    setupEnv: envPlan?.resolved.setupEnv ?? input.setupEnv,
    resolveMcpEnv,
    fakeAiProviderOverride:
      envPlan?.fakeAiProviderOverride ??
      input.resolveFakeAiProviderOverride?.(resolvedEnvironment) ??
      input.fakeAiProviderOverride,
    currentExecutionInfo:
      input.resolveCurrentExecutionInfo?.(resolvedEnvironment) ??
      input.currentExecutionInfo,
  };
}

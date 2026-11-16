import { stat } from "node:fs/promises";
import path from "node:path";
import { BrokenDevcontainerReference } from "@scarn/sdk/environment";
import {
  resolveEnvironmentDefinition,
  type EnvironmentDefinition,
} from "@scarn/sdk/resolve-environment";
import type { LaunchedRuntimeOrchestrator } from "../contracts/process-project-work-types";

type LaunchInput = Parameters<LaunchedRuntimeOrchestrator["launch"]>[0];

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
  if (!input.startAgent) envPlan?.resolveMcpEnv?.([]);
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

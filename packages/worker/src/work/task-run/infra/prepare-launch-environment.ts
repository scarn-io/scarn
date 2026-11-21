import { readEnvironmentDefinition } from "@scarn/sdk/resolve-environment";
import type { LaunchedRuntimeOrchestrator } from "../contracts/process-project-work-types";
import type { LocalProjectRuntimeEnvironmentDeps } from "./local-project-runtime-environment-deps";
import { setUpLaunchBranches } from "./launch-branch-setup";
import { resolveLaunchEnvironment } from "./resolve-launch-environment";
import { buildEnvironmentDiagnostics } from "../contracts/environment-diagnostics";
import { withInferredMcpEnv } from "../application/resolve-step-env";
import { renderBaseBranch } from "../application/render-base-branch";
import { mergeExtraConnectors } from "../application/merge-extra-connectors";

/** Validates the run's environment before branch selection and inspects runtime files after checkout. */
export async function prepareLaunchEnvironment(
  input: Parameters<LaunchedRuntimeOrchestrator["launch"]>[0],
  deps: LocalProjectRuntimeEnvironmentDeps,
  workspacePath: string,
  defaultBranch: string,
) {
  const branchInput = {
    gitCommitPushService: deps.gitCommitPushService,
    workspacePath,
    resolvedBranch: defaultBranch,
    repo: input.repo,
    stepKey: input.stepKey,
    taskRunId: input.currentExecutionInfo.taskRunId,
    baseWorkBranch: input.baseWorkBranch,
    localEnvVars: input.localEnvVars ?? {},
    repoContextGit: deps.repoContextGit,
    repoContext: input.repoContext,
    logger: input.logger,
  };
  const environmentDefinition = readEnvironmentDefinition(input.environment);
  if (environmentDefinition instanceof Error) throw environmentDefinition;
  const extraConnectors = input.extraConnectors ?? [];
  const extraConnectorIds = extraConnectors.map((extra) => extra.connectorId);
  const definition = mergeExtraConnectors(
    environmentDefinition,
    extraConnectors,
  );
  const stepBaseBranch = input.repoContext
    ? null
    : input.stepBaseBranch !== undefined
      ? input.stepBaseBranch
      : await renderBaseBranch(input.repo.baseBranch, {
          inputJson: input.stepInputJson,
          envVars: environmentDefinition.envVars,
          workerEnv: { ...process.env, ...input.localEnvVars },
          loadWorkItem: input.loadCommitWorkItem,
          environmentLabel:
            input.environment?.kind === "named" &&
            "version" in input.environment
              ? `environment ${input.environment.name} v${String(input.environment.version)}`
              : undefined,
        });
  const branches = await setUpLaunchBranches({
    ...branchInput,
    stepBaseBranch,
  });
  const resolved = await resolveLaunchEnvironment(
    input,
    workspacePath,
    branches.devcontainerLookupBranch,
    definition,
  );
  const environmentDiagnostics = buildEnvironmentDiagnostics(
    resolved.resolvedEnvironment,
    {
      definitionVersion:
        input.environment?.kind === "named" && "version" in input.environment
          ? { name: input.environment.name, version: input.environment.version }
          : null,
      checkoutCommit: await deps.readGitCommit(workspacePath, "HEAD"),
      branch: branches.devcontainerLookupBranch,
      branches: branches.branches,
    },
    withInferredMcpEnv(
      resolved.resolvedEnvironment.envVars,
      [],
      input.opencodeMcpJson,
    ),
    input.localEnvVars,
    extraConnectorIds,
  );
  const logDiagnostics = () =>
    input.logger?.log(
      "runtime",
      `Environment resolved: ${JSON.stringify(environmentDiagnostics)}`,
    );
  const resolveMcp = resolved.resolveMcpEnv;
  const resolveMcpEnv: typeof resolveMcp = resolveMcp
    ? (refs) => {
        const env = resolveMcp(refs);
        environmentDiagnostics.vars = buildEnvironmentDiagnostics(
          resolved.resolvedEnvironment,
          environmentDiagnostics,
          withInferredMcpEnv(
            resolved.resolvedEnvironment.envVars,
            refs,
            input.opencodeMcpJson,
          ),
          input.localEnvVars,
          extraConnectorIds,
        ).vars;
        logDiagnostics();
        return env;
      }
    : undefined;
  if (!resolveMcpEnv || !resolved.resolveMcpServers) logDiagnostics();
  return {
    ...branches,
    ...resolved,
    resolveMcpEnv,
    environmentDiagnostics,
  };
}

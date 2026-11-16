import path from "node:path";
import { prepareLaunchEnvironment } from "./prepare-launch-environment";
import {
  cleanupSessionHome,
  resolveSessionAgentHomeDir,
} from "../../../runtime/runtime-service/infra/opencode-agent-home";
import { startHostAgent } from "./local-host-agent-launch";
import { removeWorkItemChanges } from "@scarn/sdk/contracts/work-item-changes";
import {
  removeFindingsSubmissionFile,
  writeCurrentExecutionInfoFile,
} from "../application/process-project-work-findings";
import type {
  AgentRuntime,
  LaunchedRuntime,
  LaunchedRuntimeOrchestrator,
} from "../contracts/process-project-work-types";
import { startStopwatch } from "../../../lib/elapsed";
import { logWork } from "../application/work-logger";
import { writePreviousRunFiles } from "../application/write-previous-run-files";
import { noopLogger, type Logger } from "@scarn/observability/logging/host";
import { noopReporter } from "../contracts/work-reporter";
import {
  cleanupEnvironment,
  devcontainerHostEnv,
  inspectContainerHealthStatus,
  selectLaunchRuntimeConfig,
  resolveDevcontainerWorkspaceFolder,
} from "./local-project-runtime-environment-helpers";
import { MANAGED_RUNTIME_INSTALL_ARTIFACT_PATHS } from "../../../runtime/runtime-service/domain/managed-runtimes";
import type { ResolvedManagedRuntime } from "../../../runtime/runtime-service/domain/managed-runtimes";
import { buildCommitAndPushWorkBranch } from "./work-branch-manager";
import {
  agentLaunchSecretValues,
  prepareAgentLaunch,
  startAgentInContainer,
} from "./local-project-agent-launch";
import {
  buildLocalProjectRuntimeDeps,
  type LocalProjectRuntimeEnvironmentDeps,
} from "./local-project-runtime-environment-deps";
import { prepareGitCredentialRelay } from "./local-project-git-credentials";

export type LocalProjectRuntimeEnvironment = LaunchedRuntime;

export type LocalProjectRuntimeEnvironmentOrchestrator =
  LaunchedRuntimeOrchestrator;

/**
 * Checkout lifecycle shared by host and container launches.
 */
export class DefaultLocalProjectRuntimeEnvironmentOrchestrator implements LocalProjectRuntimeEnvironmentOrchestrator {
  /**
   * With `deps` omitted, the production deps are built per launch, so git
   * cache and credential relay settings in the run's `.scarn/.env` apply.
   */
  constructor(
    private readonly logger: Logger = noopLogger,
    private readonly fixedDeps?: LocalProjectRuntimeEnvironmentDeps,
  ) {}

  async launch(
    input: Parameters<LaunchedRuntimeOrchestrator["launch"]>[0],
  ): Promise<LocalProjectRuntimeEnvironment> {
    const { repo } = input;
    let managedRuntime: ResolvedManagedRuntime | null = null;
    const reporter = input.reporter ?? noopReporter;
    const taskRunId = input.taskRunId ?? input.currentExecutionInfo.taskRunId;
    const localEnvVars = input.localEnvVars ?? {};
    const deps =
      this.fixedDeps ?? buildLocalProjectRuntimeDeps(this.logger, localEnvVars);
    let workspacePath: string | null = null;
    let devcontainerId: string | null = null;
    let agent: AgentRuntime | null = null;
    let hostPid: number | null = null;
    let sessionAgentHomeDir: string | null = null;
    let payloadVersion: string | null = null;
    let secretValues: readonly string[] = [];
    let gitCredentialRelay: { stop(): Promise<void> } | null = null;

    try {
      logWork("runtime", "Creating local runtime environment", {
        sessionId: input.sessionId,
        projectId: input.projectId,
        requestedByUserId: input.requestedByUserId,
        gitUrl: input.gitUrl,
        baseWorkBranch: input.baseWorkBranch ?? null,
      });

      // Step 1: Create workspace + clone the repo into it.
      const workspace = await deps.workspaceManager.createWorkspace({
        sessionId: input.sessionId,
      });
      workspacePath = workspace.workspacePath;

      reporter.event({ type: "task:runtime-cloning", taskRunId });
      const elapsedClone = startStopwatch();
      const cloneResult = await deps.gitCloneService.cloneRepository({
        gitUrl: input.gitUrl,
        workspacePath,
        logger: input.logger,
      });
      input.logger?.log("runtime", `repository cloned in ${elapsedClone()}`);

      const {
        workBranch,
        createdFromBranch,
        submoduleWorkBranch,
        devcontainerLookupBranch,
        resolvedEnvironment,
        environmentDiagnostics,
        stepEnv,
        setupEnv,
        resolveMcpEnv,
        fakeAiProviderOverride,
        currentExecutionInfo,
      } = await prepareLaunchEnvironment(
        input,
        deps,
        workspacePath,
        cloneResult.resolvedBranch,
      );
      const isHost = resolvedEnvironment.runtime.kind === "host";
      sessionAgentHomeDir = isHost
        ? resolveSessionAgentHomeDir(input.sessionId)
        : null;
      await writeCurrentExecutionInfoFile(workspacePath, currentExecutionInfo);
      if (input.previousRun) {
        await writePreviousRunFiles(
          workspacePath,
          input.previousRun,
          input.logger,
        );
      }

      // Remove any findings submission file carried over from the previous
      // step's work branch (this branch was cloned from it). Otherwise the
      // monitor's first poll reads the stale file and fails the step before
      // the agent starts.
      await removeFindingsSubmissionFile(workspacePath);
      await removeWorkItemChanges(workspacePath);

      let devcontainerConfigPath = "";
      let agentWorkspaceFolder = workspacePath;
      if (isHost && sessionAgentHomeDir && input.startAgent) {
        const started = await startHostAgent({
          deps,
          sessionId: input.sessionId,
          projectId: input.projectId,
          requestedByUserId: input.requestedByUserId,
          workspacePath,
          sessionAgentHomeDir,
          opencodeMcpJson: input.opencodeMcpJson,
          connectors: resolvedEnvironment.connectors,
          fakeAiProviderOverride,
          stepEnv,
          resolveMcpEnv,
          reporter,
          taskRunId,
          onAgentLogReady: input.onAgentLogReady,
          onSecretValues: input.onSecretValues,
        });
        hostPid = started.pid;
        agent = started.agent;
        payloadVersion = started.payloadVersion;
        secretValues = started.secretValues;
      } else if (!isHost) {
        // Step 2: Resolve the devcontainer config + its workspace folder: the
        // cloned repo's, or for a managed runtime one synthesized into the clone.
        // Only a code step (no agent) runs pipeline-builder code, so only it
        // installs the pipeline-builder dependencies.
        const selected = await selectLaunchRuntimeConfig({
          devcontainerLauncher: deps.devcontainerLauncher,
          workspacePath,
          lookupBranch: devcontainerLookupBranch,
          runtime: resolvedEnvironment.runtime,
          startAgent: input.startAgent,
        });
        devcontainerConfigPath = selected.devcontainerConfigPath;
        managedRuntime = selected.managedRuntime;
        if (managedRuntime) {
          input.logger?.log(
            "runtime",
            `managed runtime ${managedRuntime.id} (${managedRuntime.definition.image})`,
          );
        }
        const devcontainerWorkspaceFolder =
          await resolveDevcontainerWorkspaceFolder({
            workspacePath,
            devcontainerConfigPath,
          });
        // The agent-facing workspace folder inside the devcontainer: the declared
        // workspaceFolder, or the CLI convention /workspaces/<basename>.
        agentWorkspaceFolder =
          devcontainerWorkspaceFolder ??
          `/workspaces/${path.basename(workspacePath)}`;
        logWork("runtime", "Resolved devcontainer config", {
          sessionId: input.sessionId,
          devcontainerConfigPath,
          devcontainerWorkspaceFolder,
          agentWorkspaceFolder,
        });

        gitCredentialRelay = await prepareGitCredentialRelay({
          deps: deps,
          repo,
          sessionId: input.sessionId,
          runContext: {
            taskRunId,
            claimToken: input.claimToken,
            repoGitUrl: input.gitUrl,
          },
          workspacePath,
          devcontainerConfigPath,
          logger: input.logger,
          onSecretValues: input.onSecretValues,
        });

        // Step 3b: For steps that start an agent, resolve the step's MCP server
        // refs and the env they need (a missing ref, or a required MCP's missing
        // variable, fails here, before the container starts), ensure
        // the OpenCode runtime payload, materialize provider access, and patch
        // the devcontainer
        // config with the payload mounts, published port and host-gateway
        // runArgs. A step without an agent launches an unmodified devcontainer.
        const plan = input.startAgent
          ? await prepareAgentLaunch({
              deps: deps,
              sessionId: input.sessionId,
              projectId: input.projectId,
              requestedByUserId: input.requestedByUserId,
              workspacePath,
              devcontainerConfigPath,
              agentWorkspaceFolder,
              opencodeMcpJson: input.opencodeMcpJson,
              connectors: resolvedEnvironment.connectors,
              stepEnv,
              resolveMcpEnv,
            })
          : null;
        payloadVersion = plan?.payload.version ?? null;
        secretValues = plan ? agentLaunchSecretValues(plan) : [];
        input.onSecretValues?.(secretValues);

        // Step 4: Launch the devcontainer. Stream the CLI's lifecycle progress
        // (notably the long-running postCreateCommand) to the reporter so the
        // user sees real activity instead of a seemingly-frozen spinner.
        reporter.event({
          type: "task:runtime-container-starting",
          taskRunId,
        });
        const devcontainerResult = await deps.devcontainerLauncher.launch({
          sessionId: input.sessionId,
          projectId: input.projectId,
          requestedByUserId: input.requestedByUserId,
          workspacePath,
          devcontainerConfigPath,
          ...devcontainerHostEnv(setupEnv, deps.gitCacheDir),
          onProgress: ({ kind, phase, level }) => {
            // Presentation: rolling live window in the terminal.
            reporter.event({
              type: "task:runtime-container-progress",
              taskRunId,
              kind,
              phase,
              level,
            });
            // Durable feed: ship each line to the server as it appears, at the
            // CLI's own severity so errors survive the ship-level filter.
            input.onDevcontainerLogLine?.(phase, level);
          },
        });
        devcontainerId = devcontainerResult.containerId;

        // Step 4b/5/6: With the container running, seed the agent HOME, build
        // the OpenCode context, and start OpenCode inside the devcontainer.
        // Skipped for steps that do not start an agent.
        agent = plan
          ? await startAgentInContainer({
              deps: deps,
              plan,
              sessionId: input.sessionId,
              containerId: devcontainerId,
              workspacePath,
              agentWorkspaceFolder,
              fakeAiProviderOverride,
              reporter,
              taskRunId,
            })
          : null;

        logWork("runtime", "Local runtime environment ready", {
          sessionId: input.sessionId,
          workspacePath,
          resolvedBranch: cloneResult.resolvedBranch,
          devcontainerConfigPath,
          devcontainerId,
          agentBaseUrl: agent?.baseUrl ?? null,
          opencodeRuntimeVersion: payloadVersion,
        });
      }

      const checkableDevcontainerId = devcontainerId;
      const capturedDevcontainerId = devcontainerId;
      const capturedWorkspacePath = workspacePath;
      const capturedWorkBranch = workBranch;

      return {
        resolvedEnvironment,
        environmentDiagnostics,
        workspacePath,
        workspaceFolder: agentWorkspaceFolder,
        resolvedBranch: cloneResult.resolvedBranch,
        workBranch,
        createdFromBranch,
        commitAndPushWorkBranch:
          capturedWorkBranch && repo.mode === "readWrite"
            ? buildCommitAndPushWorkBranch({
                gitCommitPushService: deps.gitCommitPushService,
                submoduleService: deps.submoduleService,
                workspacePath: capturedWorkspacePath,
                workBranch: capturedWorkBranch,
                submoduleWorkBranch: submoduleWorkBranch ?? undefined,
                taskRunId: input.currentExecutionInfo.taskRunId,
                message: repo.message,
                inputJson: input.stepInputJson,
                loadWorkItem: input.loadCommitWorkItem,
                onPushFailure: repo.onPushFailure,
                extraExcludePaths: [
                  ...(devcontainerConfigPath ? [devcontainerConfigPath] : []),
                  ...(managedRuntime
                    ? MANAGED_RUNTIME_INSTALL_ARTIFACT_PATHS
                    : []),
                ],
              })
            : undefined,
        devcontainerConfigPath,
        // Single runtime container id: the devcontainer, which also hosts
        // OpenCode.
        runtimeContainerId: devcontainerId,
        agent,
        // No AI image is used; surface the pinned OpenCode runtime version
        // (empty when no agent was started).
        aiImage: payloadVersion ? `opencode-runtime@${payloadVersion}` : "",
        networkName: "",
        // Provider token(s) injected into the container (Path B). The caller
        // registers these with the log masker before the in-container tail is
        // attached so they can never surface in the shipped feed. Empty when
        // no agent was started: no provider env was materialized.
        secretValues,
        ...(checkableDevcontainerId
          ? {
              checkContainerHealth: async () => ({
                runtimeContainerStatus: await inspectContainerHealthStatus(
                  checkableDevcontainerId,
                ),
              }),
            }
          : {}),
        cleanup: async () => {
          if (hostPid !== null) deps.hostOpencodeBootstrap.stop(hostPid);
          await Promise.allSettled([
            agent && capturedDevcontainerId
              ? deps.opencodeBootstrap.stop(capturedDevcontainerId)
              : Promise.resolve(),
            gitCredentialRelay?.stop(),
            sessionAgentHomeDir
              ? cleanupSessionHome(sessionAgentHomeDir)
              : Promise.resolve(),
            cleanupEnvironment({
              workspacePath: capturedWorkspacePath,
              devcontainerId: capturedDevcontainerId,
              deps: deps,
            }),
          ]);
        },
      };
    } catch (error) {
      await gitCredentialRelay?.stop().catch(() => undefined);
      if (hostPid !== null) deps.hostOpencodeBootstrap.stop(hostPid);
      if (input.preserveRuntimeOnFailure) {
        logWork(
          "runtime",
          "Preserving runtime environment after failed launch",
          {
            sessionId: input.sessionId,
            workspacePath,
            devcontainerId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        throw error;
      }
      logWork("runtime", "Runtime environment launch failed; cleaning up", {
        sessionId: input.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      await Promise.allSettled([
        sessionAgentHomeDir
          ? cleanupSessionHome(sessionAgentHomeDir)
          : Promise.resolve(),
        agent && devcontainerId
          ? deps.opencodeBootstrap.stop(devcontainerId)
          : Promise.resolve(),
        cleanupEnvironment({
          workspacePath,
          devcontainerId,
          deps: deps,
        }),
      ]);
      throw error;
    }
  }
}

import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { HealthCheck } from "@scarn/sdk/health-checks";
import { assertNever } from "../../../common/assert-never";
import { createUuidV7, type UuidV7 } from "../../../common/contracts/uuid-v7";
import { planClaimedStepEnv } from "./plan-step-env-with-secrets";
import { requestProjectSecrets } from "./request-project-secrets";
import { taskKindUsesAgent } from "./task-kind-runtime";
import { runAgentStepBranch } from "./process-claimed-task-run-agent-branch";
import { runCodeStepBranch } from "./process-claimed-task-run-code-branch";
import {
  fetchWorkerContext,
  launchRuntimeEnvironment,
} from "./process-claimed-task-run-launch";
import {
  attachTrackedAgentSession,
  createTrackedSession,
  markTrackedSessionFailed,
  markTrackedSessionRunning,
} from "./process-claimed-task-run-tracker";
import {
  resolveProjectWorkLogger,
  resolveProjectWorkReporter,
} from "./process-project-work-logger";
import type {
  OpencodeServerHandle,
  ProcessProjectWorkDeps,
  StartedClaimedTask,
  TaskRunTracker,
  TaskRunWorkerClaim,
  TaskRunWorkerClient,
} from "../contracts/process-project-work-types";
import type { FakeAiServer } from "../infra/fake-ai";
import type { RunHandle } from "./run-registry";
import {
  runLaunchGatesOrThrow,
  startHealthCheckHarnessIfDeclared,
} from "./health-check-gate";

/**
 * The subset of {@link TaskLogStreaming} this module drives: attaching
 * the in-container OpenCode log tail and the structured conversation stream
 * once their respective prerequisites (container, agent session) exist.
 */
type ClaimedTaskRunLogStream = {
  registerSecretValues(values: readonly string[]): void;
  attachOpencodeTail(input: {
    runtimeContainerId: string | null;
    opencodeLogDirectory: string;
    hostAgentLogPath?: string | null | undefined;
  }): void;
  attachConversationStream(input: {
    server: OpencodeServerHandle;
    sessionId: string;
  }): void;
  shipDevcontainerLogLine(line: string, level: "info" | "warn" | "error"): void;
};

export async function startProcessClaimedTaskRun(
  input: {
    projectId: UuidV7;
    requestedByUserId: UuidV7;
    claim: TaskRunWorkerClaim;
    leaseDurationSeconds: number;
    /**
     * This run's `.scarn/.env` values (see `ProcessProjectWorkInput.readLocalEnv`).
     * Laid over `process.env` to form the worker env, and handed to the launch.
     */
    localEnvVars?: Readonly<Record<string, string>> | undefined;
    /**
     * `scarn work -k`: keep the runtime (container, workspace, on-disk
     * artifacts) when startup fails — during the launch itself or afterwards
     * (e.g. a failed health check) — so the failure can be inspected. The
     * monitor's `cleanupRuntime` covers failures after a successful start.
     */
    preserveRuntimeOnFailure?: boolean | undefined;
    /**
     * The run's registry handle. Checked between launch stages so an abort
     * stops the launch at the next stage boundary.
     */
    run?: RunHandle | undefined;
    /**
     * Called once the run's managed launch is registered, before OpenCode
     * starts (arms the heartbeat's control-loss watchdog).
     */
    onManagedLaunchRegistered?: (() => void) | undefined;
  },
  deps: ProcessProjectWorkDeps,
  client: TaskRunWorkerClient,
  tracker: TaskRunTracker,
  logStream?: ClaimedTaskRunLogStream,
): Promise<StartedClaimedTask> {
  const logger = resolveProjectWorkLogger(deps);
  const reporter = resolveProjectWorkReporter(deps);
  const localRuntimeSessionId = createUuidV7();

  reporter.event({
    type: "task:starting",
    taskRunId: input.claim.task.id,
  });
  logger.log("step", "Starting claimed task", {
    projectId: input.projectId,
    requestedByUserId: input.requestedByUserId,
    taskRunId: input.claim.task.id,
    claimToken: input.claim.claimToken,
    localRuntimeSessionId,
    leaseDurationSeconds: input.leaseDurationSeconds,
  });
  let cleanup: (() => Promise<void>) | null = null;
  let taskRunId: UuidV7 = input.claim.task.id;
  // The fake-AI harness (#120): only started for a step that declares
  // `healthChecks`, stopped again as soon as those checks finish (success or
  // failure) — well before the agent is prompted. Tracked here (rather than
  // scoped to the `try` block) so the `catch` block can stop it too if
  // something throws before the normal stop point is reached.
  let fakeAiServer: FakeAiServer | undefined;

  await createTrackedSession(tracker, {
    localRuntimeSessionId,
    projectId: input.projectId,
    taskRunId: input.claim.task.id,
  });
  logger.log("step", "Created local runtime session record", {
    localRuntimeSessionId,
    taskRunId: input.claim.task.id,
  });

  const throwIfAborted = () => {
    input.run?.throwIfAborted();
  };

  try {
    input.run?.setPhase("launching");
    throwIfAborted();
    logger.log("step", "Fetching worker context", {
      taskRunId: input.claim.task.id,
    });
    const workerContext = await fetchWorkerContext(client, input.claim);
    input.run?.setTaskName(workerContext.task.name);
    logger.log("step", "Fetched worker context", {
      taskRunId: input.claim.task.id,
      workerContextProjectId: workerContext.projectId,
      gitUrl: workerContext.gitUrl,
      baseWorkBranch: workerContext.baseWorkBranch ?? null,
      stepDefinitionKey: workerContext.task.key,
      stepDefinitionName: workerContext.task.name,
      sessionTitle: workerContext.agentPrompt.sessionTitle,
      promptLength: workerContext.agentPrompt.promptText.length,
    });

    const workerEnv = { ...process.env, ...input.localEnvVars };
    let stepEnv: Record<string, string> = {};
    let promptEnv: Record<string, string> = {};

    // Steps whose kind does not prompt an agent (`code`: a plain function run
    // in the devcontainer) never declare health checks (no prompting harness
    // to gate), never get an OpenCode server, and skip prompt rendering. The
    // runtime environment (launch, work-branch checkout) stays required
    // exactly as for an agent step.
    const { kind } = workerContext.task;
    const usesAgent = taskKindUsesAgent(kind);

    // A step declaring no health checks must be byte-identical to today: no
    // fake-AI harness starts, no synthetic provider is registered, and
    // `fakeAiProviderOverride` stays unset below.
    const declaredHealthChecks: HealthCheck[] = usesAgent
      ? (workerContext.runtime.healthChecksJson ?? [])
      : [];
    throwIfAborted();

    logger.log("step", "Launching runtime environment", {
      taskRunId: input.claim.task.id,
      localRuntimeSessionId,
      declaredHealthCheckCount: declaredHealthChecks.length,
    });
    reporter.event({
      type: "task:runtime-launching",
      taskRunId: input.claim.task.id,
    });
    const environment = await launchRuntimeEnvironment(deps, {
      startAgent: usesAgent,
      claimToken: input.claim.claimToken,
      onSecretValues: logStream
        ? (values) => {
            logStream.registerSecretValues(values);
          }
        : undefined,
      onManagedLaunchRegistered: input.onManagedLaunchRegistered,
      localRuntimeSessionId,
      workerContext,
      requestedByUserId: input.requestedByUserId,
      reporter,
      taskRunId: input.claim.task.id,
      localEnvVars: input.localEnvVars,
      onDevcontainerLogLine: logStream
        ? (line, level) => {
            logStream.shipDevcontainerLogLine(line, level);
          }
        : undefined,
      // Host runs: mirror the serve log from the moment it exists, so a startup
      // failure (bad config, crash) is streamed instead of lost with the
      // session home on cleanup. Secrets first — the raw log can echo them.
      onAgentLogReady: logStream
        ? ({ logDirectory, hostLogPath, secretValues }) => {
            logStream.registerSecretValues(secretValues);
            logStream.attachOpencodeTail({
              runtimeContainerId: null,
              opencodeLogDirectory: logDirectory,
              hostAgentLogPath: hostLogPath,
            });
          }
        : undefined,
      resolveEnvironmentEnv: async (resolvedEnvironment) => {
        const plan = await planClaimedStepEnv({
          envVars: resolvedEnvironment.envVars,
          inputJson: workerContext.task.inputJson,
          workerEnv,
          localEnvVars: input.localEnvVars,
          opencodeMcpJson: workerContext.runtime.opencodeMcpJson,
          requestSecrets: (names) =>
            requestProjectSecrets(client, input.claim, names),
          onSecretValues: (values) => logStream?.registerSecretValues(values),
        });
        stepEnv = plan.resolved.stepEnv;
        promptEnv = plan.resolved.promptEnv;
        logStream?.registerSecretValues(plan.resolved.secretValues);
        const resolveMcp = plan.resolveMcpEnv;
        const resolveMcpEnv: typeof resolveMcp = resolveMcp
          ? (refs) => {
              const resolved = resolveMcp(refs);
              stepEnv = resolved.stepEnv;
              promptEnv = resolved.promptEnv;
              return resolved;
            }
          : undefined;
        const harness = usesAgent
          ? await startHealthCheckHarnessIfDeclared({
              healthChecks: declaredHealthChecks,
              isNoWorkspace: resolvedEnvironment.runtime.kind === "host",
              createFakeAiServer: deps.createFakeAiServer,
            })
          : { fakeAiServer: undefined, fakeAiProviderOverride: undefined };
        fakeAiServer = harness.fakeAiServer;
        return {
          ...plan,
          resolveMcpEnv,
          fakeAiProviderOverride: harness.fakeAiProviderOverride,
        };
      },
      preserveRuntimeOnFailure: input.preserveRuntimeOnFailure,
    });
    cleanup = async () => {
      await environment.cleanup();
    };
    throwIfAborted();
    // Register the provider token(s) injected into the container (Path B) with
    // the log masker BEFORE attaching the in-container log tail below — that
    // tail mirrors the raw OpenCode log, which can echo those values. Path A
    // (.scarn/.env) values were already seeded when the stream was created.
    logStream?.registerSecretValues(environment.secretValues);
    // Now that the runtime container exists, start mirroring the in-container
    // OpenCode log into the `ai-server` stream of the same feed.
    if (environment.agent) {
      logStream?.attachOpencodeTail({
        runtimeContainerId: environment.runtimeContainerId,
        opencodeLogDirectory: environment.agent.logDirectory,
        hostAgentLogPath: environment.agent.hostLogPath,
      });
    }
    logger.log("step", "Runtime environment launched", {
      taskRunId: input.claim.task.id,
      localRuntimeSessionId,
      workspacePath: environment.workspacePath,
      resolvedBranch: environment.resolvedBranch,
      devcontainerConfigPath: environment.devcontainerConfigPath,
      runtimeContainerId: environment.runtimeContainerId,
      agentBaseUrl: environment.agent?.baseUrl ?? null,
      aiImage: environment.aiImage,
      networkName: environment.networkName,
      environmentDiagnostics: environment.environmentDiagnostics,
    });
    reporter.event({
      type: "task:runtime-ready",
      taskRunId: input.claim.task.id,
    });

    // The launch gates: the MCP startup gate (decision 10), then declared
    // health checks (#120). A failure throws here, before any provider tokens
    // are spent and before the prompt is even rendered.
    try {
      await runLaunchGatesOrThrow({
        usesAgent,
        environment,
        stepMcpServerKeys: Object.keys(
          workerContext.runtime.opencodeMcpJson ?? {},
        ),
        mcpStartupGate: deps.mcpStartupGate,
        fakeAiServer,
        healthChecks: declaredHealthChecks,
        runHealthChecksOverride: deps.runHealthChecks,
        logger,
        reporter,
        taskRunId: input.claim.task.id,
      });
    } finally {
      // Stopped by the gates on every path; cleared so the `catch` block
      // below doesn't try to stop it again.
      fakeAiServer = undefined;
    }

    throwIfAborted();
    await markTrackedSessionRunning(tracker, {
      localRuntimeSessionId,
      workspacePath: environment.workspacePath,
      runtimeContainerId: environment.runtimeContainerId,
      agentBaseUrl: environment.agent?.baseUrl ?? null,
      resolvedBranch: environment.resolvedBranch,
      devcontainerConfigPath: environment.devcontainerConfigPath,
      aiImage: environment.aiImage,
      networkName: environment.networkName,
    });
    logger.log("step", "Marked local runtime session as running", {
      localRuntimeSessionId,
      taskRunId: input.claim.task.id,
      workspacePath: environment.workspacePath,
      runtimeContainerId: environment.runtimeContainerId,
    });

    const stepArtifactsDir = path.join(
      environment.workspacePath,
      ".scarn",
      "step-artifacts",
    );
    await mkdir(stepArtifactsDir, { recursive: true });
    throwIfAborted();

    switch (kind) {
      case "code": {
        await runCodeStepBranch({
          deps,
          logger,
          reporter,
          workerContext,
          environment,
          taskRunId: input.claim.task.id,
          localRuntimeSessionId,
          stepEnv,
        });
        taskRunId = input.claim.task.id;
        return {
          projectId: input.projectId,
          localRuntimeSessionId,
          taskRunId,
          claimToken: input.claim.claimToken,
          agentSessionId: null,
          environment,
        };
      }
      case "agent": {
        const { sessionId: agentSessionId, sessionRestored } =
          await runAgentStepBranch({
            deps,
            logger,
            reporter,
            workerContext,
            environment,
            taskRunId: input.claim.task.id,
            localRuntimeSessionId,
            stepArtifactsDir,
            workerEnv,
            promptEnv,
            onSessionCreated: (sessionId, server) => {
              logStream?.attachConversationStream({ server, sessionId });
            },
          });
        await attachTrackedAgentSession(
          tracker,
          localRuntimeSessionId,
          agentSessionId,
        );
        logger.log("step", "Attached agent session to local runtime session", {
          localRuntimeSessionId,
          agentSessionId,
        });
        taskRunId = input.claim.task.id;
        return {
          projectId: input.projectId,
          localRuntimeSessionId,
          taskRunId,
          claimToken: input.claim.claimToken,
          agentSessionId,
          sessionRestored,
          environment,
        };
      }
      default:
        return assertNever(kind);
    }
  } catch (error) {
    const failureReason =
      error instanceof Error ? error.message : String(error);
    logger.error("step", "Claimed task failed", {
      taskRunId: input.claim.task.id,
      localRuntimeSessionId,
      error,
    });
    reporter.event({
      type: "task:failed",
      taskRunId: input.claim.task.id,
      reason: failureReason,
    });
    // failClaimedTaskRunIfStillRunning is intentionally NOT called here. The
    // log shipper's final flush must complete before the step is marked
    // failed — otherwise the API rejects log appends once the status
    // leaves "running". The caller (scheduleClaimedTaskRunJob) owns
    // that call, after awaiting logStream.stop().
    await markTrackedSessionFailed(tracker, {
      localRuntimeSessionId,
      failureReason,
      metadataJson: JSON.stringify({
        finalStepStatus: "failed",
      }),
    });
    logger.log("step", "Marked local runtime session failed after error", {
      localRuntimeSessionId,
      taskRunId: input.claim.task.id,
    });
    logger.log("step", "Cleaning up startup artifacts after failure", {
      taskRunId,
      localRuntimeSessionId,
      hasCleanup: cleanup !== null,
    });
    // Normally already stopped (and cleared) right after health checks
    // complete; only still set here if something threw before that point
    // (e.g. the runtime launch itself failed).
    if (fakeAiServer) {
      // eslint-disable-next-line local/no-unknown-parameter-type -- narrows a caught value, not a real input boundary
      await fakeAiServer.stop().catch((stopError: unknown) => {
        logger.error(
          "step",
          "Failed to stop the fake AI server after failure",
          {
            taskRunId: input.claim.task.id,
            error:
              stopError instanceof Error
                ? stopError.message
                : String(stopError),
          },
        );
      });
    }
    if (input.preserveRuntimeOnFailure) {
      logger.log("step", "Preserving runtime environment after failure", {
        taskRunId,
        localRuntimeSessionId,
      });
    } else {
      await cleanup?.();
    }
    throw error;
  }
}

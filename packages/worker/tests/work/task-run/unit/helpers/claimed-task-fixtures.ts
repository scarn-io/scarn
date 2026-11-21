/**
 * Shared fixtures for `process-claimed-task-run*.test.ts`. Split out so
 * neither test file has to duplicate this scaffolding, and so both stay
 * under the repo's per-file line limit.
 */
import path from "node:path";
import { vi } from "bun:test";
import type { ResolvedEnvironmentRef } from "@scarn/sdk/environment";
import type { EnvVarSpec } from "@scarn/sdk/env-vars";
import {
  readEnvironmentDefinition,
  resolveEnvironmentDefinition,
} from "@scarn/sdk/resolve-environment";
import { mergeExtraConnectors } from "../../../../../src/work/task-run/application/merge-extra-connectors";
import { parseUuidV7 } from "../../../../../src/common/contracts/uuid-v7";
import type { pollMcpStatus } from "../../../../../src/work/task-run/application/poll-mcp-status";
import { startProcessClaimedTaskRun } from "../../../../../src/work/task-run/application/process-claimed-task-run";
import type {
  ProcessProjectWorkDeps,
  TaskRunTracker,
  TaskRunWorkerClient,
  TaskRunWorkerContext,
  LaunchedRuntimeOrchestrator,
  LaunchedRuntime,
} from "../../../../../src/work/task-run/contracts/process-project-work-types";

/**
 * An MCP startup gate poll that reports every expected server `connected`,
 * for claimed-run tests that declare step MCP servers but run no OpenCode.
 */
export const connectedMcpStartupGate = {
  poll: (
    _server: Parameters<typeof pollMcpStatus>[0],
    options?: Parameters<typeof pollMcpStatus>[1],
  ) =>
    Promise.resolve(
      (options?.expectedServers ?? []).map((name) => ({
        name,
        status: "connected" as const,
        healthy: true,
      })),
    ),
};

export const projectId = parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe001");
export const requestedByUserId = parseUuidV7(
  "01966a2c-9494-7db5-aa46-0f8f5cbbe002",
);
export const taskRunId = parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe003");
export const hostEnvironment = {
  kind: "inline",
  runtime: { kind: "host" },
} as const;
type WorkerContextTask = TaskRunWorkerContext["task"];
type WorkerContextRuntime = TaskRunWorkerContext["runtime"];

export type WorkerContextOverrides = Partial<WorkerContextTask> &
  Partial<WorkerContextRuntime>;

export function createWorkerContext(
  environment: ResolvedEnvironmentRef = null,
  healthChecksJson?: WorkerContextRuntime["healthChecksJson"],
  overrides: WorkerContextOverrides = {},
): TaskRunWorkerContext {
  const task: WorkerContextTask = {
    id: taskRunId,
    status: "running",
    kind: "agent",
    key: "demo-step",
    name: "Demo Step",
    inputJson: { title: "Checkout bug" },
    executionTimeoutSeconds: 120,
    prompt:
      "Open {{env.BASE_URL}} for {{input.title}} and save to {{scarn.artifactsDir}}trace.zip. Legacy: {{title}} and {{stepArtifactsDir}}trace.zip.",
    entrypointJson: null,
    toolCall: null,
    resultSchemaJson: { type: "object" },
    grants: [],
  };
  const runtime: WorkerContextRuntime = {
    environment,
    repo:
      environment?.kind === "inline" && environment.runtime?.kind === "host"
        ? {
            mode: "readOnly",
            gitCredentials: "none",
            baseBranch: null,
          }
        : {
            mode: "readWrite",
            message: null,
            onPushFailure: "fail",
            gitCredentials: "none",
            baseBranch: null,
            workBranch: { kind: "create" },
          },
    healthChecksJson: healthChecksJson ?? null,
    opencodeMcpJson: null,
    extraConnectors: [],
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (key in task) Object.assign(task, { [key]: value });
    else Object.assign(runtime, { [key]: value });
  }
  return {
    projectId,
    gitUrl: "https://github.com/example/repo.git",
    projectOpencodeConfig: {
      relativePath: ".scarn/scarn.jsonc",
      present: false,
      commands: [],
      services: [],
    },
    task,
    runtime,
    agentPrompt: {
      sessionTitle: "Demo Step",
      promptText: "Header\n__SCARN_STEP_INSTRUCTIONS__\nFooter",
      instructionsPlaceholder: "__SCARN_STEP_INSTRUCTIONS__",
    },
  };
}

/** A `kind: "code"` worker context: no prompt, a resolved entrypoint. */
export function createCodeStepWorkerContext(
  entrypointJson: WorkerContextTask["entrypointJson"] = {
    sourceFile: ".scarn/pipeline-builder/review-file-step.ts",
  },
  envJson: EnvVarSpec[] | null = null,
  runtime: NonNullable<
    Extract<ResolvedEnvironmentRef, { kind: "inline" }>["runtime"]
  > = {
    kind: "managed",
    id: "bun1",
  },
): TaskRunWorkerContext {
  return createWorkerContext({ kind: "inline", runtime, envJson }, null, {
    kind: "code",
    prompt: null,
    entrypointJson,
  });
}

/** A `kind: "mcp_tool"` worker context: no prompt, a Notion search tool call. */
export function createMcpToolStepWorkerContext(): TaskRunWorkerContext {
  return createWorkerContext(
    { kind: "inline", runtime: { kind: "managed", id: "bun1" }, envJson: null },
    null,
    {
      kind: "mcp_tool",
      prompt: null,
      toolCall: {
        server: "notion",
        tool: "search",
        argsTemplate: { query: "{{input.title}}" },
        toolSchemas: { input: { type: "object" }, output: null },
      },
    },
  );
}

export function createRunTracker(): TaskRunTracker {
  return {
    createSession: vi.fn(() => Promise.resolve(undefined)),
    markRunning: vi.fn(() => Promise.resolve(undefined)),
    attachAgentSession: vi.fn(() => Promise.resolve(undefined)),
    markSucceeded: vi.fn(() => Promise.resolve(undefined)),
    markFailed: vi.fn(() => Promise.resolve(undefined)),
    close: vi.fn(() => Promise.resolve(undefined)),
  };
}

export function createWorkerClient(
  environment: ResolvedEnvironmentRef = null,
): TaskRunWorkerClient {
  return {
    userId: requestedByUserId,
    claimTaskRuns: vi.fn(),
    heartbeatTaskRun: vi.fn(() =>
      Promise.resolve({
        status: "running" as const,
        managedAuthority: "ok" as const,
      }),
    ),
    reportTaskRunBaseCommit: vi.fn(),
    failTaskRun: vi.fn(),
    completeTaskRun: vi.fn(),
    yieldTaskRun: vi.fn(),
    appendTaskLogs: vi.fn(() => Promise.resolve({ nextOffset: 0 })),
    getTaskRun: vi.fn(),
    getTaskRunWorkerContext: vi.fn(() =>
      Promise.resolve(createWorkerContext(environment)),
    ),
    createArtifactUploadUrl: vi.fn(),
    createSessionUploadUrl: vi.fn(),
    recordArtifact: vi.fn(),
    recordArtifactFailure: vi.fn(),
  };
}

export function runClaim(
  deps: ProcessProjectWorkDeps,
  options: {
    tracker?: TaskRunTracker;
    localEnvVars?: Record<string, string>;
  } = {},
) {
  return startProcessClaimedTaskRun(
    {
      projectId,
      requestedByUserId,
      claim: {
        task: { id: taskRunId },
        claimToken: "claim-token",
      },
      leaseDurationSeconds: 30,
      localEnvVars: options.localEnvVars,
    },
    deps,
    deps.workerClient,
    options.tracker ?? createRunTracker(),
  );
}

/**
 * A recording runtime-environment orchestrator: its `launch` resolves the same
 * fake environment the existing test uses, but records that it was invoked so
 * routing between container and host runtime launches can be
 * asserted through the exported {@link startProcessClaimedTaskRun} seam
 * (`resolveRuntimeEnvironmentOrchestrator` itself is module-private).
 */
export function createRecordingOrchestrator(
  workspacePath: string,
  overrides: Partial<Omit<LaunchedRuntime, "resolvedEnvironment">> = {},
) {
  const lifecycle = vi.fn<(phase: "cloned" | "resolved" | "startup") => void>();
  const launch = vi.fn<LaunchedRuntimeOrchestrator["launch"]>(async (input) => {
    lifecycle("cloned");
    const definition = readEnvironmentDefinition(input.environment);
    if (definition instanceof Error) throw definition;
    const resolvedEnvironment = await resolveEnvironmentDefinition(
      { devcontainerExists: () => Promise.resolve(true) },
      mergeExtraConnectors(definition, input.extraConnectors ?? []),
    );
    if (resolvedEnvironment instanceof Error) throw resolvedEnvironment;
    lifecycle("resolved");
    if (
      resolvedEnvironment.runtime.kind === "host" &&
      input.taskKind === "code"
    ) {
      throw new Error(
        `Code step "${input.stepKey ?? ""}" cannot use the host runtime.`,
      );
    }
    const envPlan = await input.resolveEnvironmentEnv?.(resolvedEnvironment);
    if (envPlan) {
      input.stepEnv = envPlan.resolved.stepEnv;
      input.setupEnv = envPlan.resolved.setupEnv;
      input.resolveMcpEnv = envPlan.resolveMcpEnv;
      input.fakeAiProviderOverride = envPlan.fakeAiProviderOverride;
      input.onSecretValues?.(envPlan.resolved.secretValues);
    }
    input.currentExecutionInfo =
      input.resolveCurrentExecutionInfo?.(resolvedEnvironment) ??
      input.currentExecutionInfo;
    input.fakeAiProviderOverride ??=
      input.resolveFakeAiProviderOverride?.(resolvedEnvironment);
    lifecycle("startup");
    return {
      resolvedEnvironment,
      workspacePath,
      workspaceFolder: "/workspaces/repo",
      resolvedBranch: "",
      workBranch: null,
      createdFromBranch: null,
      devcontainerConfigPath: "",
      runtimeContainerId: null,
      agent: {
        baseUrl: "http://localhost:4096",
        password: "test-password",
        version: "0.0.0-test",
        logDirectory: path.join(workspacePath, ".logs"),
      },
      aiImage: "opencode-runtime@test",
      networkName: "",
      secretValues: [],
      cleanup: () => Promise.resolve(),
      ...overrides,
    };
  });
  return { launch, lifecycle };
}

export function createRoutingDeps(input: {
  workerClient: TaskRunWorkerClient;
  workspaceOrchestrator: { launch: ReturnType<typeof vi.fn> };
}): ProcessProjectWorkDeps {
  return {
    workerClient: input.workerClient,
    createRunTracker,
    runtimeEnvironmentOrchestrator: input.workspaceOrchestrator,
    agentRunner: {
      promptAsync: vi.fn(() =>
        Promise.resolve({ sessionId: "agent-session-id" }),
      ),
      getSessionStatus: vi.fn(),
      abort: vi.fn(() => Promise.resolve(undefined)),
      sendRetryPrompt: vi.fn(),
    },
    artifactStore: {
      saveArtifact: vi.fn(),
    },
    sleep: vi.fn(() => Promise.resolve(undefined)),
    logger: {
      debug: vi.fn(),
      log: vi.fn(),
      error: vi.fn(),
    },
    mcpStartupGate: connectedMcpStartupGate,
  } satisfies ProcessProjectWorkDeps;
}

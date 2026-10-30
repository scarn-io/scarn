/**
 * Shared fixtures for `process-claimed-task-run*.test.ts`. Split out so
 * neither test file has to duplicate this scaffolding, and so both stay
 * under the repo's per-file line limit.
 */
import path from "node:path";
import { vi } from "bun:test";
import { parseUuidV7 } from "../../../../../src/common/contracts/uuid-v7";
import { startProcessClaimedTaskRun } from "../../../../../src/work/task-run/application/process-claimed-task-run";
import type {
  ProcessProjectWorkDeps,
  TaskRunTracker,
  TaskRunWorkerClient,
  TaskRunWorkerContext,
} from "../../../../../src/work/task-run/contracts/process-project-work-types";

export const projectId = parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe001");
export const requestedByUserId = parseUuidV7(
  "01966a2c-9494-7db5-aa46-0f8f5cbbe002",
);
export const taskRunId = parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe003");
type WorkerContextTask = TaskRunWorkerContext["task"];
type WorkerContextRuntime = TaskRunWorkerContext["runtime"];

export type WorkerContextOverrides = Partial<WorkerContextTask> &
  Partial<WorkerContextRuntime>;

export function createWorkerContext(
  executionMode?: "workspace" | "no_workspace",
  healthChecksJson?: WorkerContextRuntime["healthChecksJson"],
  overrides: WorkerContextOverrides = {},
): TaskRunWorkerContext {
  const resolvedExecutionMode = executionMode ?? "workspace";
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
    resultSchemaJson: { type: "object" },
  };
  const runtime: WorkerContextRuntime = {
    executionMode: resolvedExecutionMode,
    devcontainerConfigPath: null,
    managedRuntime: null,
    repo:
      resolvedExecutionMode === "no_workspace"
        ? { mode: "none" }
        : { mode: "readWrite", message: null, onPushFailure: "fail" },
    envJson: null,
    healthChecksJson: healthChecksJson ?? null,
    opencodeMcpJson: null,
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
  envJson: WorkerContextRuntime["envJson"] = null,
  managedRuntime: WorkerContextRuntime["managedRuntime"] = null,
): TaskRunWorkerContext {
  return createWorkerContext("workspace", null, {
    kind: "code",
    prompt: null,
    entrypointJson,
    envJson,
    managedRuntime,
  });
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
  executionMode: "workspace" | "no_workspace" = "workspace",
): TaskRunWorkerClient {
  return {
    userId: requestedByUserId,
    claimTaskRuns: vi.fn(),
    heartbeatTaskRun: vi.fn(),
    failTaskRun: vi.fn(),
    completeTaskRun: vi.fn(),
    yieldTaskRun: vi.fn(),
    appendTaskLogs: vi.fn(() => Promise.resolve({ nextOffset: 0 })),
    getTaskRun: vi.fn(),
    getTaskRunWorkerContext: vi.fn(() =>
      Promise.resolve(createWorkerContext(executionMode)),
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
    workerEnv?: Record<string, string | undefined>;
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
      workerEnv: options.workerEnv,
    },
    deps,
    deps.workerClient,
    options.tracker ?? createRunTracker(),
  );
}

/**
 * A recording runtime-environment orchestrator: its `launch` resolves the same
 * fake environment the existing test uses, but records that it was invoked so
 * routing between the `workspace` and `no_workspace` orchestrators can be
 * asserted through the exported {@link startProcessClaimedTaskRun} seam
 * (`resolveRuntimeEnvironmentOrchestrator` itself is module-private).
 */
export function createRecordingOrchestrator(
  workspacePath: string,
  overrides: {
    resolvedBranch?: string;
    devcontainerConfigPath?: string;
    runtimeContainerId?: string | null;
    aiImage?: string;
    networkName?: string;
  } = {},
) {
  const launch = vi.fn(() =>
    Promise.resolve({
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
    }),
  );
  return { launch };
}

export function createRoutingDeps(input: {
  workerClient: TaskRunWorkerClient;
  workspaceOrchestrator: { launch: ReturnType<typeof vi.fn> };
  noWorkspaceOrchestrator?: { launch: ReturnType<typeof vi.fn> } | undefined;
}): ProcessProjectWorkDeps {
  return {
    workerClient: input.workerClient,
    createRunTracker,
    runtimeEnvironmentOrchestrator: input.workspaceOrchestrator,
    ...(input.noWorkspaceOrchestrator
      ? {
          noWorkspaceRuntimeEnvironmentOrchestrator:
            input.noWorkspaceOrchestrator,
        }
      : {}),
    agentRunner: {
      promptAsync: vi.fn(() =>
        Promise.resolve({ sessionId: "agent-session-id" }),
      ),
      getSessionStatus: vi.fn(),
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
  } satisfies ProcessProjectWorkDeps;
}

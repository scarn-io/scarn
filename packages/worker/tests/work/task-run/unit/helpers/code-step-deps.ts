/**
 * Shared `ProcessProjectWorkDeps` scaffolding for the
 * `process-claimed-task-run-code-step*.test.ts` files: a code step's worker
 * context, a recording orchestrator, and an agent runner that must never be
 * prompted.
 */
import { vi } from "bun:test";
import type {
  LaunchedRuntime,
  ProcessProjectWorkDeps,
} from "../../../../../src/work/task-run/contracts/process-project-work-types";
import {
  createCodeStepWorkerContext,
  createRecordingOrchestrator,
  createRunTracker,
  createWorkerClient,
} from "./claimed-task-fixtures";

export function buildCodeStepDeps(input: {
  workspacePath: string;
  entrypointJson: { sourceFile: string };
  runCodeStepCommand: ProcessProjectWorkDeps["runCodeStepCommand"];
  envJson?: Parameters<typeof createCodeStepWorkerContext>[1];
  runtime?: Parameters<typeof createCodeStepWorkerContext>[2];
  mcpCalls?: LaunchedRuntime["mcpCalls"];
  openMcpBridgeSession?: ProcessProjectWorkDeps["openMcpBridgeSession"];
}): {
  deps: ProcessProjectWorkDeps;
  tracker: ReturnType<typeof createRunTracker>;
  launch: ReturnType<typeof vi.fn>;
} {
  const { launch } = createRecordingOrchestrator(input.workspacePath, {
    resolvedBranch: "main",
    workBranch: null,
    createdFromBranch: null,
    devcontainerConfigPath: ".devcontainer/devcontainer.json",
    runtimeContainerId: "runtime-container-id",
    agent: null,
    aiImage: "",
    networkName: "test-network",
    ...(input.mcpCalls ? { mcpCalls: input.mcpCalls } : {}),
  });

  const workerClient = createWorkerClient();
  workerClient.getTaskRunWorkerContext = vi.fn(() =>
    Promise.resolve(
      createCodeStepWorkerContext(
        input.entrypointJson,
        input.envJson,
        input.runtime,
      ),
    ),
  );

  const tracker = createRunTracker();
  const deps = {
    workerClient,
    createRunTracker: () => tracker,
    runtimeEnvironmentOrchestrator: { launch },
    agentRunner: {
      promptAsync: vi.fn(() =>
        Promise.reject(
          new Error("promptAsync must not be called for a code step"),
        ),
      ),
      getSessionStatus: vi.fn(),
      abort: vi.fn(() => Promise.resolve(undefined)),
      sendRetryPrompt: vi.fn(),
    },
    artifactStore: {
      saveArtifact: vi.fn(),
    },
    sleep: vi.fn(() => Promise.resolve(undefined)),
    logger: { debug: vi.fn(), log: vi.fn(), error: vi.fn() },
    runCodeStepCommand: input.runCodeStepCommand,
    openMcpBridgeSession: input.openMcpBridgeSession,
  } satisfies ProcessProjectWorkDeps;

  return { deps, tracker, launch };
}

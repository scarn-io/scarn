import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "bun:test";
import { parseUuidV7 } from "../../../../../src/common/contracts/uuid-v7";
import { writeCurrentExecutionInfoFile } from "../../../../../src/work/task-run/application/process-project-work-findings";
import { monitorStartedClaimedTaskRun } from "../../../../../src/work/task-run/application/process-project-work-monitor";
import { buildEndConversationPath } from "../../../../../src/work/task-run/application/process-project-work-turn-end";
import type {
  CommitAndPushWorkBranchContext,
  ProcessProjectWorkDeps,
  ProcessProjectWorkInput,
  StartedClaimedTask,
  TaskRunTracker,
} from "../../../../../src/work/task-run/contracts/process-project-work-types";
import type { WorkEvent } from "../../../../../src/work/task-run/contracts/work-reporter";

/** Shared harness for the monitor's turn-end tests: hand-over, limits and ending. */
export const TASK_ID = parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe003");

export async function createWorkspace(): Promise<string> {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "scarn-monitor-yield-"),
  );
  await mkdir(path.join(workspacePath, ".scarn"), { recursive: true });
  return workspacePath;
}

export const RESULT_SCHEMA = {
  type: "object",
  required: ["summary"],
  additionalProperties: false,
  properties: { summary: { type: "string" } },
};

export async function writeExecutionInfo(
  workspacePath: string,
  input: { conversation: boolean; turnsRemaining: number | null },
): Promise<void> {
  await writeCurrentExecutionInfoFile(workspacePath, {
    taskRunId: TASK_ID,
    resultSchemaJson: input.conversation ? null : RESULT_SCHEMA,
    turnsRemaining: input.turnsRemaining,
  });
}

export async function writeEndConversationMarker(
  workspacePath: string,
): Promise<void> {
  await writeFile(
    buildEndConversationPath(workspacePath),
    JSON.stringify({ endedAt: new Date().toISOString() }),
  );
}

export async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function createStartedTask(
  workspacePath: string,
  commitAndPushWorkBranch: (
    context: CommitAndPushWorkBranchContext,
  ) => Promise<{ pushed: boolean }>,
): StartedClaimedTask {
  return {
    projectId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe001"),
    localRuntimeSessionId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe002"),
    taskRunId: TASK_ID,
    claimToken: "claim-token",
    agentSessionId: "agent-session-id",
    environment: {
      workspacePath,
      workspaceFolder: "/workspaces/repo",
      resolvedBranch: "main",
      workBranch: "scarn/task-1",
      createdFromBranch: "main",
      devcontainerConfigPath: ".devcontainer/devcontainer.json",
      runtimeContainerId: "runtime-container-id",
      agent: {
        baseUrl: "http://127.0.0.1:4096",
        password: "test-password",
        version: "0.0.0-test",
        logDirectory: path.join(workspacePath, ".logs"),
      },
      aiImage: "opencode-runtime@0.0.0-test",
      networkName: "",
      secretValues: [],
      commitAndPushWorkBranch,
      cleanup: vi.fn(() => Promise.resolve()),
    },
  };
}

export function createTracker(): TaskRunTracker {
  return {
    createSession: vi.fn(),
    markRunning: vi.fn(),
    attachAgentSession: vi.fn(),
    markSucceeded: vi.fn(() => Promise.resolve()),
    markFailed: vi.fn(() => Promise.resolve()),
    close: vi.fn(),
  };
}

export function createInput(
  startedTask: StartedClaimedTask,
): ProcessProjectWorkInput {
  return {
    projectId: startedTask.projectId,
    batchSize: 1,
    concurrency: 1,
    pollIntervalMs: 0,
    missingFindingsGraceMs: 0,
    leaseDurationSeconds: 30,
    workerId: "worker-1",
    preserveRuntimeOnComplete: true,
    once: true,
  };
}

export function createHarness(
  startedTask: StartedClaimedTask,
  options: { finalText: string },
) {
  let statusCall = 0;
  let completed = false;
  const events: WorkEvent[] = [];
  const yieldTaskRun = vi.fn(() => Promise.resolve(undefined));
  const completeTaskRun = vi.fn(() => {
    completed = true;
    return Promise.resolve(undefined);
  });
  const sendRetryPrompt = vi.fn(() => Promise.resolve(undefined));
  const saveArtifact = vi.fn();
  const createSessionUploadUrl = vi.fn();
  const exportSession = vi.fn(() => Promise.reject(new Error("unavailable")));
  const deps: ProcessProjectWorkDeps = {
    workerClient: {
      userId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe004"),
      claimTaskRuns: vi.fn(),
      heartbeatTaskRun: vi.fn(),
      failTaskRun: vi.fn(() => Promise.resolve(undefined)),
      completeTaskRun,
      yieldTaskRun,
      getTaskRun: vi.fn(() =>
        Promise.resolve({
          status: completed ? ("succeeded" as const) : ("running" as const),
        }),
      ),
      getTaskRunWorkerContext: vi.fn(),
      createArtifactUploadUrl: vi.fn(),
      createSessionUploadUrl,
      recordArtifact: vi.fn(),
      recordArtifactFailure: vi.fn(),
      appendTaskLogs: vi.fn(() => Promise.resolve({ nextOffset: 0 })),
    },
    createRunTracker: vi.fn(),
    runtimeEnvironmentOrchestrator: { launch: vi.fn() },
    agentRunner: {
      promptAsync: vi.fn(),
      getSessionStatus: vi.fn(() => {
        statusCall += 1;
        return Promise.resolve({ running: statusCall === 1 });
      }),
      sendRetryPrompt,
      readLastAssistantText: vi.fn(() => Promise.resolve(options.finalText)),
      exportSession,
    },
    artifactStore: { saveArtifact },
    sleep: vi.fn(() => Promise.resolve(undefined)),
    logger: { debug: vi.fn(), log: vi.fn(), error: vi.fn() },
    reporter: {
      startActivity: vi.fn(),
      info: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      event: (event: WorkEvent) => {
        events.push(event);
      },
    },
  };
  const logStream = {
    flush: vi.fn(() => Promise.resolve()),
    mask: (text: string) => text.replaceAll("hunter2", "***"),
  };
  return {
    deps,
    events,
    yieldTaskRun,
    completeTaskRun,
    sendRetryPrompt,
    saveArtifact,
    createSessionUploadUrl,
    exportSession,
    logStream,
  };
}

export const stopStub = () => ({ stop: vi.fn(() => Promise.resolve()) });

export async function runMonitor(
  startedTask: StartedClaimedTask,
  harness: ReturnType<typeof createHarness>,
  tracker: TaskRunTracker = createTracker(),
): Promise<void> {
  await monitorStartedClaimedTaskRun(
    createInput(startedTask),
    harness.deps,
    tracker,
    startedTask,
    stopStub(),
    harness.logStream,
  );
}

export function retryPromptTexts(harness: ReturnType<typeof createHarness>) {
  return harness.sendRetryPrompt.mock.calls.map(
    (call) => (call as unknown as [{ promptText: string }])[0].promptText,
  );
}

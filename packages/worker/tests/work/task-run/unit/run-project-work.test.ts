import { afterEach, describe, expect, vi } from "bun:test";
import { parseUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import type {
  TaskAgentRunner,
  TaskRunTracker,
  TaskRuntimeEnvironmentOrchestrator,
  TaskRunWorkerClient,
  TaskRunWorkerContext,
} from "../../../../src/work/task-run/contracts/process-project-work-types";
import { processProjectWork } from "../../../../src/work/task-run/application/run-project-work";
import { concurrentTest } from "../../../utils";

const projectId = "01966a2c-9494-7db5-aa46-0f8f5cbbe001";
const userId = parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe002");
const taskRunId = parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe004");

function createRunTracker(): TaskRunTracker {
  return {
    createSession: vi.fn(),
    markRunning: vi.fn(),
    attachAgentSession: vi.fn(),
    markSucceeded: vi.fn(),
    markFailed: vi.fn(),
    close: vi.fn(),
  };
}

function createWorkerClient(
  overrides?: Partial<TaskRunWorkerClient>,
): TaskRunWorkerClient {
  const claimTaskRuns: TaskRunWorkerClient["claimTaskRuns"] = vi.fn(() =>
    Promise.resolve([]),
  );
  const heartbeatTaskRun: TaskRunWorkerClient["heartbeatTaskRun"] = vi.fn(() =>
    Promise.resolve(undefined),
  );
  const failTaskRun: TaskRunWorkerClient["failTaskRun"] = vi.fn(() =>
    Promise.resolve(undefined),
  );
  const completeTaskRun: TaskRunWorkerClient["completeTaskRun"] = vi.fn(() =>
    Promise.resolve(undefined),
  );
  const getTaskRun: TaskRunWorkerClient["getTaskRun"] = vi.fn(() =>
    Promise.resolve({ status: "succeeded" as const }),
  );
  const getTaskRunWorkerContext: TaskRunWorkerClient["getTaskRunWorkerContext"] =
    vi.fn(() =>
      Promise.resolve({
        projectId: parseUuidV7(projectId),
        gitUrl: "https://github.com/example/repo.git",
        projectOpencodeConfig: {
          relativePath: ".scarn/scarn.jsonc",
          present: false,
          commands: [],
          services: [],
        },
        task: {
          id: taskRunId,
          status: "running",
          kind: "agent",
          key: "demo-step",
          name: "Demo Step",
          inputJson: null,
          executionTimeoutSeconds: 120,
          prompt: "Run the demo step.",
          entrypointJson: null,
          resultSchemaJson: { type: "object" },
        },
        runtime: {
          executionMode: "workspace",
          devcontainerConfigPath: null,
          managedRuntime: null,
          repo: { mode: "readWrite", message: null, onPushFailure: "fail" },
          envJson: null,
          healthChecksJson: null,
          opencodeMcpJson: null,
        },
        agentPrompt: {
          sessionTitle: "Demo Step",
          promptText: "Run it.",
          instructionsPlaceholder: "__SCARN_STEP_INSTRUCTIONS__",
        },
      } satisfies TaskRunWorkerContext),
    );
  return {
    userId,
    claimTaskRuns,
    heartbeatTaskRun,
    failTaskRun,
    completeTaskRun,
    yieldTaskRun: vi.fn(() => Promise.resolve(undefined)),
    appendTaskLogs: vi.fn(() => Promise.resolve({ nextOffset: 0 })),
    getTaskRun,
    getTaskRunWorkerContext,
    createArtifactUploadUrl: vi.fn(() =>
      Promise.resolve({
        uploadUrl: "https://fake-upload.local/artifact",
        storeRef: "remote://artifact",
        objectKey: "artifact",
        expiresInSeconds: 300,
      }),
    ),
    createSessionUploadUrl: vi.fn(() =>
      Promise.resolve({
        uploadUrl: "https://fake-upload.local/session",
        objectKey: "tasks/session.json",
        expiresInSeconds: 900,
      }),
    ),
    recordArtifact: vi.fn(() => Promise.resolve(undefined)),
    recordArtifactFailure: vi.fn(() => Promise.resolve(undefined)),
    ...overrides,
  };
}

describe("CLI processProjectWork", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  concurrentTest(
    "resolves the base URL and default worker settings before delegating to core",
    async () => {
      const claimTaskRuns: TaskRunWorkerClient["claimTaskRuns"] = vi.fn(() =>
        Promise.resolve([]),
      );
      const workerClient = createWorkerClient({ claimTaskRuns });
      const createWorkerClientForBaseUrl = vi.fn(() =>
        Promise.resolve(workerClient),
      );

      const result = await processProjectWork(
        {
          projectId,
          baseUrl: "https://example.com///",
          once: true,
        },
        {
          createWorkerClient: createWorkerClientForBaseUrl,
          createRunTracker,
          runtimeEnvironmentOrchestrator: {
            launch: vi.fn(() => Promise.reject(new Error("Not used"))),
          } satisfies TaskRuntimeEnvironmentOrchestrator,
          agentRunner: {
            promptAsync: vi.fn(() => Promise.reject(new Error("Not used"))),
            getSessionStatus: vi.fn(() => Promise.resolve({ running: false })),
            sendRetryPrompt: vi.fn(() => Promise.resolve(undefined)),
          } satisfies TaskAgentRunner,
          sleep: () => Promise.resolve(undefined),
          logger: {
            debug: vi.fn(),
            log: vi.fn(),
            error: vi.fn(),
          },
        },
      );

      expect(createWorkerClientForBaseUrl).toHaveBeenCalledWith(
        "https://example.com",
      );
      expect(claimTaskRuns).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: parseUuidV7(projectId),
          batchSize: 1,
          leaseDurationSeconds: 30,
        }),
      );
      expect(result).toEqual({
        claimedCount: 0,
        processedCount: 0,
        skippedCount: 0,
      });
    },
  );

  concurrentTest(
    "uses concurrency as the default batch size when batch size is omitted",
    async () => {
      const claimTaskRuns: TaskRunWorkerClient["claimTaskRuns"] = vi.fn(() =>
        Promise.resolve([]),
      );
      const workerClient = createWorkerClient({ claimTaskRuns });

      await processProjectWork(
        {
          projectId,
          concurrency: 2,
          workerId: "worker-2",
          once: true,
        },
        {
          createWorkerClient: () => Promise.resolve(workerClient),
          createRunTracker,
          runtimeEnvironmentOrchestrator: {
            launch: vi.fn(() => Promise.reject(new Error("Not used"))),
          } satisfies TaskRuntimeEnvironmentOrchestrator,
          agentRunner: {
            promptAsync: vi.fn(() => Promise.reject(new Error("Not used"))),
            getSessionStatus: vi.fn(() => Promise.resolve({ running: false })),
            sendRetryPrompt: vi.fn(() => Promise.resolve(undefined)),
          } satisfies TaskAgentRunner,
          sleep: () => Promise.resolve(undefined),
          logger: {
            debug: vi.fn(),
            log: vi.fn(),
            error: vi.fn(),
          },
        },
      );

      expect(claimTaskRuns).toHaveBeenCalledWith({
        projectId: parseUuidV7(projectId),
        workerId: "worker-2",
        batchSize: 2,
        leaseDurationSeconds: 30,
      });
    },
  );

  concurrentTest(
    "uses prod url as the default base URL when no base URL is configured",
    async () => {
      const workerClient = createWorkerClient();
      const createWorkerClientForBaseUrl = vi.fn(() =>
        Promise.resolve(workerClient),
      );
      const previousBaseUrl = process.env["SCARN_BASE_URL"];

      delete process.env["SCARN_BASE_URL"];

      try {
        await processProjectWork(
          {
            projectId,
            once: true,
          },
          {
            createWorkerClient: createWorkerClientForBaseUrl,
            createRunTracker,
            runtimeEnvironmentOrchestrator: {
              launch: vi.fn(() => Promise.reject(new Error("Not used"))),
            } satisfies TaskRuntimeEnvironmentOrchestrator,
            agentRunner: {
              promptAsync: vi.fn(() => Promise.reject(new Error("Not used"))),
              getSessionStatus: vi.fn(() =>
                Promise.resolve({ running: false }),
              ),
              sendRetryPrompt: vi.fn(() => Promise.resolve(undefined)),
            } satisfies TaskAgentRunner,
            sleep: () => Promise.resolve(undefined),
            logger: {
              debug: vi.fn(),
              log: vi.fn(),
              error: vi.fn(),
            },
          },
        );
      } finally {
        if (previousBaseUrl === undefined) {
          delete process.env["SCARN_BASE_URL"];
        } else {
          process.env["SCARN_BASE_URL"] = previousBaseUrl;
        }
      }

      expect(createWorkerClientForBaseUrl).toHaveBeenCalledWith(
        "https://app.scarn.io",
      );
    },
  );
});

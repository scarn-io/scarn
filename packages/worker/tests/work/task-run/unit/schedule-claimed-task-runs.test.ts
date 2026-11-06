import { describe, expect, test, vi } from "bun:test";
import { parseUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { scheduleClaimedTaskRunJob } from "../../../../src/work/task-run/application/schedule-claimed-task-runs";
import type {
  ProcessProjectWorkDeps,
  TaskRunTracker,
  TaskRunWorkerClaim,
  TaskRunWorkerClient,
} from "../../../../src/work/task-run/contracts/process-project-work-types";
import { captureRejection } from "../../../support/capture-rejection";

const projectId = parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe001");
const claim: TaskRunWorkerClaim = {
  task: { id: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe003") },
  claimToken: "claim-token",
};

function createTracker(): TaskRunTracker {
  return {
    createSession: vi.fn(),
    markRunning: vi.fn(),
    attachAgentSession: vi.fn(),
    markSucceeded: vi.fn(),
    markFailed: vi.fn(),
    close: vi.fn(),
  };
}

describe("scheduleClaimedTaskRunJob", () => {
  test.concurrent(
    "reports a failure before stopping the heartbeat",
    async () => {
      const order: string[] = [];
      const workerClient = {
        userId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe002"),
        claimTaskRuns: vi.fn(),
        heartbeatTaskRun: vi.fn(() => Promise.resolve(undefined)),
        failTaskRun: vi.fn(() => {
          order.push("failTaskRun");
          return Promise.resolve(undefined);
        }),
        completeTaskRun: vi.fn(),
        yieldTaskRun: vi.fn(),
        getTaskRun: vi.fn(() =>
          Promise.resolve({ status: "running" as const }),
        ),
        getTaskRunWorkerContext: vi.fn(() =>
          Promise.reject(new Error("context unavailable")),
        ),
        createArtifactUploadUrl: vi.fn(),
        createSessionUploadUrl: vi.fn(),
        recordArtifact: vi.fn(),
        recordArtifactFailure: vi.fn(),
        appendTaskLogs: vi.fn(() => Promise.resolve({ nextOffset: 0 })),
      } as unknown as TaskRunWorkerClient;
      const deps: ProcessProjectWorkDeps = {
        workerClient,
        createRunTracker: vi.fn(),
        runtimeEnvironmentOrchestrator: { launch: vi.fn() },
        agentRunner: {
          promptAsync: vi.fn(),
          getSessionStatus: vi.fn(),
          sendRetryPrompt: vi.fn(),
        },
        artifactStore: { saveArtifact: vi.fn() },
        sleep: () => Promise.resolve(undefined),
        logger: {
          debug: vi.fn((_scope: string, message: string) => {
            if (message === "Stopping heartbeat loop") {
              order.push("heartbeat.stop");
            }
          }),
          log: vi.fn(),
          error: vi.fn(),
        },
      };
      const activeJobs = new Set<Promise<void>>();

      scheduleClaimedTaskRunJob(
        {
          projectId,
          batchSize: 1,
          concurrency: 1,
          pollIntervalMs: 0,
          leaseDurationSeconds: 30,
          workerId: "worker-1",
          once: true,
        },
        deps,
        claim,
        createTracker(),
        { claimedCount: 1, processedCount: 0, skippedCount: 0 },
        activeJobs,
      );
      const [job] = [...activeJobs];

      const failure = await captureRejection(job ?? Promise.resolve());
      expect(failure.message).toBe("context unavailable");
      expect(order).toEqual(["failTaskRun", "heartbeat.stop"]);
    },
  );
});

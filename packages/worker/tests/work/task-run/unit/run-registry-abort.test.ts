/**
 * Per-run abort through the run registry, and draining the polling loop. A
 * run's monitor is parked in a poll sleep that never resolves on its own, so
 * a run that settles at all proves the abort cut the sleep short.
 */
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "bun:test";
import { processProjectWork } from "../../../../src/work/task-run/application/process-project-work";
import {
  RunRegistry,
  type RunAbortReason,
} from "../../../../src/work/task-run/application/run-registry";
import { scheduleClaimedTaskRunJob } from "../../../../src/work/task-run/application/schedule-claimed-task-runs";
import { TaskRunCancelledError } from "../../../../src/work/task-run/application/task-run-cancelled-error";
import { WorkerStoppedError } from "../../../../src/work/task-run/application/worker-stopped-error";
import type {
  ProcessProjectWorkDeps,
  ProcessProjectWorkInput,
  TaskRunWorkerClaim,
} from "../../../../src/work/task-run/contracts/process-project-work-types";
import { captureRejection } from "../../../support/capture-rejection";
import {
  createRecordingOrchestrator,
  createRunTracker,
  createWorkerClient,
  projectId,
  taskRunId,
} from "./helpers/claimed-task-fixtures";

const claim: TaskRunWorkerClaim = {
  task: { id: taskRunId },
  claimToken: "claim-token",
};

const input: ProcessProjectWorkInput = {
  projectId,
  workerId: "worker-1",
  batchSize: 1,
  concurrency: 1,
  pollIntervalMs: 60_000,
  leaseDurationSeconds: 30,
};

function never(): Promise<void> {
  return new Promise<void>(() => {});
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let tick = 0; tick < 400 && !condition(); tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!condition()) throw new Error("Condition never became true");
}

async function setUpRunningAgent() {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "scarn-run-registry-abort-"),
  );
  const order: string[] = [];
  const { launch } = createRecordingOrchestrator(workspacePath);
  const workerClient = {
    ...createWorkerClient(),
    completeTaskRun: vi.fn(),
    getTaskRun: vi.fn(() => Promise.resolve({ status: "running" as const })),
    appendTaskLogs: vi.fn(() => {
      order.push("appendTaskLogs");
      return Promise.resolve({ nextOffset: 0 });
    }),
    failTaskRun: vi.fn(() => {
      order.push("failTaskRun");
      return Promise.resolve(undefined);
    }),
  };
  const sleeps: number[] = [];
  const abort = vi.fn(() => Promise.resolve(undefined));
  const deps = {
    workerClient,
    createRunTracker,
    runtimeEnvironmentOrchestrator: { launch },
    agentRunner: {
      promptAsync: vi.fn(() =>
        Promise.resolve({ sessionId: "agent-session-id" }),
      ),
      getSessionStatus: vi.fn(() => Promise.resolve({ running: true })),
      abort,
      sendRetryPrompt: vi.fn(),
    },
    artifactStore: { saveArtifact: vi.fn() },
    sleep: (milliseconds: number) => {
      sleeps.push(milliseconds);
      return never();
    },
    logger: { debug: vi.fn(), log: vi.fn(), error: vi.fn() },
  } satisfies ProcessProjectWorkDeps;
  return { deps, workerClient, order, sleeps, abort };
}

async function abortWhileSleeping(reason: RunAbortReason) {
  const setUp = await setUpRunningAgent();
  const runs = new RunRegistry();
  const job = scheduleClaimedTaskRunJob(
    input,
    setUp.deps,
    claim,
    createRunTracker(),
    { claimedCount: 1, processedCount: 0, skippedCount: 0 },
    runs,
  );

  await waitUntil(() => setUp.sleeps.length > 0);
  expect(runs.get(taskRunId)?.phase).toBe("running");
  expect(runs.abort(taskRunId, reason)).toBe(true);

  const failure = await captureRejection(job);
  return { ...setUp, failure, runs };
}

describe("run registry abort", () => {
  test.concurrent(
    "an abort while the monitor sleeps ends the run without waiting for the poll interval",
    async () => {
      const { failure, sleeps, runs } = await abortWhileSleeping("cancelled");

      expect(failure).toBeInstanceOf(TaskRunCancelledError);
      expect(sleeps).toEqual([input.pollIntervalMs]);
      expect(runs.count()).toBe(0);
    },
  );

  test.concurrent(
    "aborting with cancelled reports nothing to the server",
    async () => {
      const { failure, workerClient, abort } =
        await abortWhileSleeping("cancelled");

      expect(failure).toBeInstanceOf(TaskRunCancelledError);
      expect(workerClient.failTaskRun).not.toHaveBeenCalled();
      expect(workerClient.completeTaskRun.mock.calls).toEqual([]);
      expect(abort).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "agent-session-id" }),
      );
    },
  );

  test.concurrent(
    "aborting with worker_stopped reports WORKER_STOPPED after the log flush",
    async () => {
      const { failure, workerClient, order, abort } =
        await abortWhileSleeping("worker_stopped");

      expect(failure).toBeInstanceOf(WorkerStoppedError);
      expect(abort).toHaveBeenCalledTimes(1);
      const [report] = workerClient.failTaskRun.mock.calls as unknown as [
        { taskRunId: string; claimToken: string; errorJson: { code: string } },
      ][];
      expect(report?.[0]).toMatchObject({
        taskRunId,
        claimToken: "claim-token",
        errorJson: { code: "WORKER_STOPPED" },
      });
      expect(order).toContain("appendTaskLogs");
      expect(order.at(-1)).toBe("failTaskRun");
    },
  );

  test("abortAll aborts every run, and runs started after it", async () => {
    const runs = new RunRegistry();
    const reasons: (RunAbortReason | null)[] = [];
    const record = (handle: { abortReason(): RunAbortReason | null }) => {
      reasons.push(handle.abortReason());
      return Promise.resolve();
    };
    let releaseFirst!: () => void;
    const first = runs.start({ taskRunId: "run-1", projectId }, (handle) =>
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }).then(() => record(handle)),
    );

    expect(runs.abortAll("worker_stopped")).toBe(1);
    releaseFirst();
    await first;
    await runs.start({ taskRunId: "run-2", projectId }, record);

    expect(reasons).toEqual(["worker_stopped", "worker_stopped"]);
  });
});

describe("draining the polling loop", () => {
  test.concurrent(
    "stops claiming and cuts the idle sleep short, but lets active jobs finish",
    async () => {
      let releaseLaunch = () => {};
      const launchGate = new Promise<void>((resolve) => {
        releaseLaunch = resolve;
      });
      const launch = vi.fn(async () => {
        await launchGate;
        throw new Error("launch released");
      });
      const claimTaskRuns = vi.fn(() =>
        Promise.resolve(claimTaskRuns.mock.calls.length === 1 ? [claim] : []),
      );
      const deps = {
        workerClient: {
          ...createWorkerClient(),
          claimTaskRuns,
          getTaskRun: vi.fn(() =>
            Promise.resolve({ status: "running" as const }),
          ),
          failTaskRun: vi.fn(() => Promise.resolve(undefined)),
        },
        createRunTracker,
        runtimeEnvironmentOrchestrator: { launch },
        agentRunner: {
          promptAsync: vi.fn(),
          getSessionStatus: vi.fn(),
          abort: vi.fn(() => Promise.resolve(undefined)),
          sendRetryPrompt: vi.fn(),
        },
        artifactStore: { saveArtifact: vi.fn() },
        sleep: () => never(),
        logger: { debug: vi.fn(), log: vi.fn(), error: vi.fn() },
      } satisfies ProcessProjectWorkDeps;
      const drain = new AbortController();
      const runs = new RunRegistry();
      let settled = false;

      const work = processProjectWork(
        {
          ...input,
          concurrency: 2,
          drainSignal: drain.signal,
          runRegistry: runs,
        },
        deps,
      ).finally(() => {
        settled = true;
      });

      await waitUntil(() => launch.mock.calls.length === 1);
      drain.abort();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(settled).toBe(false);
      expect(claimTaskRuns).toHaveBeenCalledTimes(1);
      expect(runs.count({ projectId })).toBe(1);

      releaseLaunch();
      const result = await work;

      expect(claimTaskRuns).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        claimedCount: 1,
        processedCount: 0,
        skippedCount: 1,
      });
      expect(runs.count()).toBe(0);
    },
  );
});

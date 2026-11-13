/**
 * Project loops that share one slot allocator stay within its machine limit
 * between them, and hand every slot back once their runs settle.
 */
import { describe, expect, test, vi } from "bun:test";
import { parseUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { processProjectWork } from "../../../../src/work/task-run/application/process-project-work";
import { RunRegistry } from "../../../../src/work/task-run/application/run-registry";
import { SlotAllocator } from "../../../../src/work/worker-host/domain/slot-allocator";
import type {
  ProcessProjectWorkDeps,
  ProcessProjectWorkInput,
  TaskRunWorkerClaim,
} from "../../../../src/work/task-run/contracts/process-project-work-types";
import {
  createRunTracker,
  createWorkerClient,
  projectId,
} from "./helpers/claimed-task-fixtures";

const otherProjectId = parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe0ff");

function tick(milliseconds = 1): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !condition(); attempt += 1) {
    await tick(5);
  }
  if (!condition()) throw new Error("Condition never became true");
}

function createClaimSource() {
  let issued = 0;
  return vi.fn((request: { batchSize: number }) => {
    const claims: TaskRunWorkerClaim[] = [];
    for (let index = 0; index < request.batchSize; index += 1) {
      issued += 1;
      claims.push({
        task: {
          id: parseUuidV7(
            `01966a2c-9494-7db5-aa46-${issued.toString(16).padStart(12, "0")}`,
          ),
        },
        claimToken: `claim-${String(issued)}`,
      });
    }
    return Promise.resolve(claims);
  });
}

function createDeps(runs: RunRegistry, peak: { active: number }) {
  const launch = vi.fn(async () => {
    peak.active = Math.max(peak.active, runs.count());
    await tick(3);
    throw new Error("launch finished");
  });
  return {
    workerClient: {
      ...createWorkerClient(),
      claimTaskRuns: createClaimSource(),
      getTaskRun: vi.fn(() => Promise.resolve({ status: "running" as const })),
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
    sleep: () => tick(),
    logger: { debug: vi.fn(), log: vi.fn(), error: vi.fn() },
  } satisfies ProcessProjectWorkDeps;
}

describe("project loops sharing one slot allocator", () => {
  test("never run more at once than the machine limit", async () => {
    const machineLimit = 3;
    const slots = new SlotAllocator({ machineLimit });
    const runs = new RunRegistry();
    const peak = { active: 0 };
    const drain = new AbortController();
    const base: Omit<ProcessProjectWorkInput, "projectId"> = {
      workerId: "worker-1",
      batchSize: 3,
      concurrency: 3,
      pollIntervalMs: 1,
      leaseDurationSeconds: 30,
      runRegistry: runs,
      slots,
      drainSignal: drain.signal,
    };
    const first = createDeps(runs, peak);
    const second = createDeps(runs, peak);

    const work = Promise.all([
      processProjectWork({ ...base, projectId }, first),
      processProjectWork({ ...base, projectId: otherProjectId }, second),
    ]);

    await waitUntil(
      () =>
        first.runtimeEnvironmentOrchestrator.launch.mock.calls.length >= 5 &&
        second.runtimeEnvironmentOrchestrator.launch.mock.calls.length >= 5,
    );
    drain.abort();
    const results = await work;

    expect(peak.active).toBeGreaterThan(0);
    expect(peak.active).toBeLessThanOrEqual(machineLimit);
    expect(runs.count()).toBe(0);
    expect(slots.snapshot()).toEqual({
      machineLimit,
      machineInUse: 0,
      projects: [],
    });
    for (const result of results) {
      expect(result.processedCount + result.skippedCount).toBe(
        result.claimedCount,
      );
    }
  });

  test("hands back the slots a claim did not use", async () => {
    const slots = new SlotAllocator({ machineLimit: 4 });
    const deps = createDeps(new RunRegistry(), { active: 0 });
    deps.workerClient.claimTaskRuns.mockImplementation(() =>
      Promise.resolve([]),
    );
    const acquire = vi.spyOn(slots, "acquire");

    await processProjectWork(
      {
        projectId,
        workerId: "worker-1",
        batchSize: 2,
        concurrency: 4,
        pollIntervalMs: 1,
        leaseDurationSeconds: 30,
        once: true,
        slots,
      },
      deps,
    );

    expect(acquire).toHaveBeenCalledWith(projectId, 2);
    expect(deps.workerClient.claimTaskRuns).toHaveBeenCalledWith(
      expect.objectContaining({ batchSize: 2 }),
    );
    expect(slots.snapshot().machineInUse).toBe(0);
  });
});

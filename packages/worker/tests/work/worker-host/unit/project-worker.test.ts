/**
 * A project worker runs one project's loop inside the background worker: it
 * changes its limit and work-item filter in place, and when its loop cannot
 * run it enters an error state, keeps its runs going, and retries.
 */
import { describe, expect, test } from "bun:test";
import { parseUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { WorkerAuthError } from "../../../../src/auth/session/domain/worker-auth-error";
import { RunRegistry } from "../../../../src/work/task-run/application/run-registry";
import { ProjectUnavailableError } from "../../../../src/work/task-run/contracts/project-unavailable-error";
import type { WorkerProjectSettings } from "../../../../src/work/worker-host/contracts/worker-settings";
import { SlotAllocator } from "../../../../src/work/worker-host/domain/slot-allocator";
import { ProjectWorker } from "../../../../src/work/worker-host/application/project-worker";
import { projectId } from "../../task-run/unit/helpers/claimed-task-fixtures";
import {
  createFakeAuthWatcher,
  createFakeHostDeps,
  createFakeTimers,
  createSettings,
  NOW,
  tick,
  waitUntil,
} from "./helpers/project-worker-fakes";

function createHarness(
  options: {
    settings?: Partial<WorkerProjectSettings>;
    machineLimit?: number;
    repoExists?: boolean;
  } = {},
) {
  const fake = createFakeHostDeps();
  const slots = new SlotAllocator({ machineLimit: options.machineLimit ?? 5 });
  const runRegistry = new RunRegistry();
  const fakeTimers = createFakeTimers();
  const auth = createFakeAuthWatcher();
  const repo = { exists: options.repoExists ?? true };
  const worker = new ProjectWorker(createSettings(options.settings), {
    hostDeps: fake.hostDeps,
    slots,
    runRegistry,
    hostname: () => "box",
    repoExists: () => Promise.resolve(repo.exists),
    watchAuthFile: auth.watchAuthFile,
    schedule: fakeTimers.schedule,
    now: () => NOW,
    loopOptions: { pollIntervalMs: 1 },
  });
  return {
    worker,
    workerClient: fake.workerClient,
    createWorkerClient: fake.createWorkerClient,
    launch: fake.launch,
    slots,
    runRegistry,
    fakeTimers,
    authListeners: auth.listeners,
    repo,
    async finish() {
      fake.releaseRuns();
      await worker.drain();
    },
  };
}

describe("ProjectWorker", () => {
  test("claims with a stable worker id and the saved settings", async () => {
    const harness = createHarness({ settings: { concurrency: 1 } });

    await harness.worker.start();
    await waitUntil(() => harness.runRegistry.count() === 1);

    expect(harness.worker.state).toBe("running");
    expect(harness.createWorkerClient).toHaveBeenCalledWith(
      "http://scarn.test",
      { expectedUserId: "01966a2c-9494-7db5-aa46-0f8f5cbbe002" },
    );
    expect(harness.workerClient.claimTaskRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        workerId: `scarn-worker-box-scarn-${projectId}`,
        batchSize: 1,
      }),
    );
    await harness.finish();
    expect(harness.worker.state).toBe("stopped");
  });

  test("enters repo_missing when the repo directory is gone, and recovers once it is back", async () => {
    const harness = createHarness({ repoExists: false });

    await harness.worker.start();

    expect(harness.worker.status()).toMatchObject({
      state: "error",
      errorReason: "repo_missing",
      nextRetryAt: new Date(NOW.getTime() + 30_000).toISOString(),
    });
    expect(harness.createWorkerClient).not.toHaveBeenCalled();

    harness.repo.exists = true;
    harness.fakeTimers.fireNext();
    await waitUntil(() => harness.worker.state === "running");

    expect(harness.worker.status().errorReason).toBeNull();
    await harness.finish();
  });

  test("backs off from 30s, doubling up to 5 minutes", async () => {
    const harness = createHarness({ repoExists: false });

    await harness.worker.start();
    const delays: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      delays.push(harness.fakeTimers.pending[0]?.milliseconds ?? -1);
      harness.fakeTimers.fireNext();
      await waitUntil(() => harness.fakeTimers.pending.length === 1);
    }

    expect(delays).toEqual([
      30_000, 60_000, 120_000, 240_000, 300_000, 300_000,
    ]);
    await harness.worker.drain();
    expect(harness.fakeTimers.pending).toEqual([]);
  });

  test("changes its limit in place, without restarting the loop", async () => {
    const harness = createHarness({ settings: { concurrency: 1 } });

    await harness.worker.start();
    await waitUntil(() => harness.runRegistry.count() === 1);
    await tick(20);
    expect(harness.runRegistry.count()).toBe(1);

    const outcome = harness.worker.updateSettings(
      createSettings({ concurrency: 3 }),
    );
    await waitUntil(() => harness.runRegistry.count() === 3);

    expect(outcome).toBe("applied");
    expect(harness.slots.snapshot().projects).toEqual([
      { projectId, limit: 3, inUse: 3 },
    ]);
    expect(harness.createWorkerClient).toHaveBeenCalledTimes(1);
    expect(harness.worker.status().activeRuns).toBe(3);
    await harness.finish();
  });

  test("applies a new work-item filter from the next claim", async () => {
    const harness = createHarness();
    harness.workerClient.claimTaskRuns.mockImplementation(() =>
      Promise.resolve([]),
    );
    const claimedFor = () =>
      harness.workerClient.claimTaskRuns.mock.calls.map(
        ([request]) => request.workItemId,
      );

    await harness.worker.start();
    await waitUntil(() => claimedFor().length > 0);
    harness.worker.updateSettings(createSettings({ workItemId: "WI-7" }));
    await waitUntil(() => claimedFor().includes("WI-7"));

    expect(claimedFor()[0]).toBeUndefined();
    expect(harness.createWorkerClient).toHaveBeenCalledTimes(1);
    await harness.finish();
  });

  test("asks for a restart when the repo directory, branch or runtime setting changes", () => {
    const harness = createHarness();

    for (const change of [
      { repoDir: "/repos/other" },
      { sourceBranch: "develop" },
      { preserveRuntime: true },
    ]) {
      expect(harness.worker.updateSettings(createSettings(change))).toBe(
        "restart_required",
      );
    }
    expect(harness.worker.settings.repoDir).toBe("/repos/app");
  });

  test("resumes once its login works again after an auth error", async () => {
    const harness = createHarness();
    harness.createWorkerClient.mockImplementationOnce(() =>
      Promise.reject(
        new WorkerAuthError("auth_missing", "Not signed in to scarn.test."),
      ),
    );

    await harness.worker.start();

    expect(harness.worker.status()).toMatchObject({
      state: "error",
      errorReason: "auth_missing",
      errorMessage: "Not signed in to scarn.test.",
    });
    expect(harness.authListeners.size).toBe(1);

    for (const onChange of harness.authListeners) onChange();
    await waitUntil(() => harness.worker.state === "running");

    expect(harness.authListeners.size).toBe(0);
    expect(harness.fakeTimers.pending).toEqual([]);
    await harness.finish();
  });

  test("enters project_unavailable when the server no longer has the project", async () => {
    const harness = createHarness();
    harness.workerClient.claimTaskRuns.mockImplementationOnce(() =>
      Promise.reject(new ProjectUnavailableError(404, "Project gone.")),
    );

    await harness.worker.start();
    await waitUntil(() => harness.worker.state === "error");

    expect(harness.worker.status().errorReason).toBe("project_unavailable");
    expect(harness.authListeners.size).toBe(0);
    await harness.finish();
  });

  test("keeps active runs going after a crash, then restarts its loop", async () => {
    const harness = createHarness({ settings: { concurrency: 1 } });
    harness.workerClient.claimTaskRuns
      .mockImplementationOnce((request) =>
        Promise.resolve(
          Array.from({ length: request.batchSize }, (_, index) => ({
            task: {
              id: parseUuidV7(
                `01966a2c-9494-7db5-aa46-${(0xf00 + index).toString(16).padStart(12, "0")}`,
              ),
            },
            claimToken: `crash-claim-${String(index)}`,
          })),
        ),
      )
      .mockImplementationOnce(() => Promise.reject(new Error("boom")));

    await harness.worker.start();
    await waitUntil(() => harness.runRegistry.count() === 1);
    harness.worker.updateSettings(createSettings({ concurrency: 2 }));
    await waitUntil(() => harness.worker.state === "error");

    expect(harness.worker.status()).toMatchObject({
      errorReason: "crashed",
      errorMessage: "boom",
      activeRuns: 1,
    });
    expect(harness.launch).toHaveBeenCalledTimes(1);

    harness.fakeTimers.fireNext();
    await waitUntil(() => harness.runRegistry.count() === 2);

    expect(harness.worker.state).toBe("running");
    expect(harness.createWorkerClient).toHaveBeenCalledTimes(2);
    await harness.finish();
    expect(harness.runRegistry.count()).toBe(0);
    expect(harness.slots.snapshot().machineInUse).toBe(0);
  });
});

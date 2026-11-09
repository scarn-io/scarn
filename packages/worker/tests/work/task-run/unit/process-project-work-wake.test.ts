/**
 * Push wake-up in `runPollingLoop`: a `wake` that resolves during an idle
 * sleep re-polls at once and resets the backoff to `pollIntervalMs`.
 */
import { describe, expect, test, vi } from "bun:test";
import { parseUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { processProjectWork } from "../../../../src/work/task-run/application/process-project-work";
import type {
  ProcessProjectWorkDeps,
  ProcessProjectWorkInput,
} from "../../../../src/work/task-run/contracts/process-project-work-types";
import {
  createRunTracker,
  createWorkerClient,
} from "./helpers/claimed-task-fixtures";

const projectId = parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe007");

class StopPolling extends Error {}

const input: ProcessProjectWorkInput = {
  projectId,
  workerId: "worker-1",
  batchSize: 1,
  concurrency: 1,
  pollIntervalMs: 100,
  maxPollIntervalMs: 10_000,
  leaseDurationSeconds: 30,
};

function buildDeps(overrides: {
  claimTaskRuns: ProcessProjectWorkDeps["workerClient"]["claimTaskRuns"];
  sleep: ProcessProjectWorkDeps["sleep"];
  wake?: ProcessProjectWorkDeps["wake"];
}) {
  return {
    workerClient: {
      ...createWorkerClient(),
      claimTaskRuns: overrides.claimTaskRuns,
    },
    createRunTracker,
    runtimeEnvironmentOrchestrator: {
      launch: vi.fn(() => Promise.reject(new Error("launch not used"))),
    },
    agentRunner: {
      promptAsync: vi.fn(() => Promise.reject(new Error("not used"))),
      getSessionStatus: vi.fn(() => Promise.resolve({ running: false })),
      sendRetryPrompt: vi.fn(() => Promise.resolve(undefined)),
    },
    artifactStore: { saveArtifact: vi.fn() },
    sleep: overrides.sleep,
    wake: overrides.wake,
    logger: { debug: vi.fn(), log: vi.fn(), error: vi.fn() },
  } satisfies ProcessProjectWorkDeps;
}

async function expectStopped(promise: Promise<unknown>) {
  try {
    await promise;
    throw new Error("expected processProjectWork to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(StopPolling);
  }
}

describe("push wake-up during idle sleep", () => {
  test("a wake ends a long sleep, re-polls at once, and resets the backoff", async () => {
    let call = 0;
    const claimTaskRuns = vi.fn(() => {
      call += 1;
      return call <= 4
        ? Promise.resolve([])
        : Promise.reject(new StopPolling());
    });
    const sleepCalls: number[] = [];
    const abortedSleeps: number[] = [];
    let wakeNow: (() => void) | null = null;

    const deps = buildDeps({
      claimTaskRuns,
      sleep: (milliseconds, signal) => {
        sleepCalls.push(milliseconds);
        // The third sleep (800 ms) never finishes on its own: only a wake ends it.
        if (sleepCalls.length === 3) {
          signal?.addEventListener("abort", () => {
            abortedSleeps.push(milliseconds);
          });
          queueMicrotask(() => wakeNow?.());
          return new Promise(() => {});
        }
        return Promise.resolve();
      },
      wake: (signal) =>
        new Promise((resolve) => {
          wakeNow = resolve;
          signal.addEventListener("abort", () => {
            wakeNow = null;
          });
        }),
    });

    await expectStopped(processProjectWork(input, deps));

    expect(sleepCalls).toEqual([
      200, // first empty poll
      400, // second empty poll
      800, // third empty poll: woken mid-sleep
      200, // backoff restarted from pollIntervalMs after the wake's empty poll
    ]);
    expect(abortedSleeps).toEqual([800]);
    expect(claimTaskRuns).toHaveBeenCalledTimes(5);
  });

  test("a disconnect mid-sleep cuts it to the normal ceiling, and the reconnect wake claims at once", async () => {
    const connectedInput: ProcessProjectWorkInput = {
      ...input,
      maxPollIntervalMs: 300,
      connectedMaxPollIntervalMs: 1_000,
    };
    let call = 0;
    const claimTaskRuns = vi.fn(() => {
      call += 1;
      return call <= 4
        ? Promise.resolve([])
        : Promise.reject(new StopPolling());
    });
    let clock = 0;
    let connected = true;
    let wakeNow: (() => void) | null = null;
    let disconnectNow: (() => void) | null = null;
    const sleepCalls: number[] = [];

    const deps = {
      ...buildDeps({
        claimTaskRuns,
        sleep: (milliseconds) => {
          sleepCalls.push(milliseconds);
          if (sleepCalls.length === 3) {
            queueMicrotask(() => {
              clock += 120;
              connected = false;
              disconnectNow?.();
            });
            return new Promise(() => {});
          }
          if (sleepCalls.length === 4) {
            queueMicrotask(() => {
              connected = true;
              wakeNow?.();
            });
            return new Promise(() => {});
          }
          return Promise.resolve();
        },
        wake: (signal) =>
          new Promise((resolve) => {
            wakeNow = resolve;
            signal.addEventListener("abort", () => {
              wakeNow = null;
            });
          }),
      }),
      now: () => clock,
      signalConnection: {
        isConnected: () => connected,
        disconnected: (signal: AbortSignal) =>
          connected
            ? new Promise<void>((resolve) => {
                disconnectNow = resolve;
                signal.addEventListener("abort", () => {
                  disconnectNow = null;
                });
              })
            : Promise.resolve(),
      },
    } satisfies ProcessProjectWorkDeps;

    await expectStopped(processProjectWork(connectedInput, deps));

    expect(sleepCalls).toEqual([
      200,
      400, // above maxPollIntervalMs: allowed while connected
      800, // disconnected 120 ms in
      180, // remainder of the 300 ms normal ceiling; reconnect wakes it
      200, // backoff restarted after the reconnect's claim
    ]);
    expect(claimTaskRuns).toHaveBeenCalledTimes(5);
  });

  test("a disconnect after the normal ceiling has elapsed ends the sleep at once", async () => {
    const connectedInput: ProcessProjectWorkInput = {
      ...input,
      pollIntervalMs: 400,
      maxPollIntervalMs: 400,
      connectedMaxPollIntervalMs: 1_000,
    };
    let call = 0;
    const claimTaskRuns = vi.fn(() => {
      call += 1;
      return call <= 2
        ? Promise.resolve([])
        : Promise.reject(new StopPolling());
    });
    let clock = 0;
    let connected = true;
    let disconnectNow: (() => void) | null = null;
    const sleepCalls: number[] = [];

    const deps = {
      ...buildDeps({
        claimTaskRuns,
        sleep: (milliseconds) => {
          sleepCalls.push(milliseconds);
          if (sleepCalls.length === 1) {
            queueMicrotask(() => {
              clock += 500;
              connected = false;
              disconnectNow?.();
            });
            return new Promise(() => {});
          }
          return Promise.resolve();
        },
      }),
      now: () => clock,
      signalConnection: {
        isConnected: () => connected,
        disconnected: () =>
          new Promise<void>((resolve) => {
            disconnectNow = resolve;
          }),
      },
    } satisfies ProcessProjectWorkDeps;

    await expectStopped(processProjectWork(connectedInput, deps));

    expect(sleepCalls).toEqual([800, 400]);
    expect(claimTaskRuns).toHaveBeenCalledTimes(3);
  });

  test("--once polls a single time and never sleeps, even while connected", async () => {
    const claimTaskRuns = vi.fn(() => Promise.resolve([]));
    const sleep = vi.fn(() => Promise.resolve());
    const disconnected = vi.fn(() => new Promise<void>(() => {}));
    const deps = {
      ...buildDeps({ claimTaskRuns, sleep }),
      signalConnection: { isConnected: () => true, disconnected },
    } satisfies ProcessProjectWorkDeps;

    const result = await processProjectWork(
      { ...input, connectedMaxPollIntervalMs: 1_000, once: true },
      deps,
    );

    expect(result.claimedCount).toBe(0);
    expect(claimTaskRuns).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(disconnected).not.toHaveBeenCalled();
  });

  test("without a wake dep, sleeps are not raced (unchanged behavior)", async () => {
    let call = 0;
    const claimTaskRuns = vi.fn(() => {
      call += 1;
      return call <= 2
        ? Promise.resolve([])
        : Promise.reject(new StopPolling());
    });
    const signals: (AbortSignal | undefined)[] = [];
    const deps = buildDeps({
      claimTaskRuns,
      sleep: (_milliseconds, signal) => {
        signals.push(signal);
        return Promise.resolve();
      },
    });

    await expectStopped(processProjectWork(input, deps));

    expect(signals).toEqual([undefined, undefined]);
  });
});

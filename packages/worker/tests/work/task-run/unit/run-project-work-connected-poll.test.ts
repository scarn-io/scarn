/**
 * `runProjectWork` wiring for the connected safety-net poll: with the push
 * wake-up socket connected and nothing configured, every empty poll sleeps the
 * full 60-minute connected interval, with no ramp from `pollIntervalMs`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { processProjectWork } from "../../../../src/work/task-run/application/run-project-work";
import type { TaskRunWorkerClient } from "../../../../src/work/task-run/contracts/process-project-work-types";
import {
  createRunTracker,
  createWorkerClient,
} from "./helpers/claimed-task-fixtures";

const projectId = "01966a2c-9494-7db5-aa46-0f8f5cbbe009";

class StopPolling extends Error {}

const previousEnv = {
  poll: process.env["SCARN_WORK_POLL_INTERVAL_MS"],
  max: process.env["SCARN_WORK_MAX_POLL_INTERVAL_MS"],
  connected: process.env["SCARN_WORK_CONNECTED_MAX_POLL_INTERVAL_MS"],
};

function restore(key: string, value: string | undefined) {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}

beforeEach(() => {
  delete process.env["SCARN_WORK_POLL_INTERVAL_MS"];
  delete process.env["SCARN_WORK_MAX_POLL_INTERVAL_MS"];
  delete process.env["SCARN_WORK_CONNECTED_MAX_POLL_INTERVAL_MS"];
});

afterEach(() => {
  restore("SCARN_WORK_POLL_INTERVAL_MS", previousEnv.poll);
  restore("SCARN_WORK_MAX_POLL_INTERVAL_MS", previousEnv.max);
  restore("SCARN_WORK_CONNECTED_MAX_POLL_INTERVAL_MS", previousEnv.connected);
});

async function runUntilStopped(options: {
  connectedMaxPollIntervalMs?: number;
}) {
  let call = 0;
  const claimTaskRuns: TaskRunWorkerClient["claimTaskRuns"] = vi.fn(() => {
    call += 1;
    return call <= 10 ? Promise.resolve([]) : Promise.reject(new StopPolling());
  });
  const workerClient: TaskRunWorkerClient = {
    ...createWorkerClient(),
    claimTaskRuns,
    issueWorkSignalToken: vi.fn(() =>
      Promise.resolve({
        url: "https://signal.example",
        token: "token",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    ),
  };
  const stop = vi.fn();
  const sleepCalls: number[] = [];

  try {
    await processProjectWork(
      { projectId, ...options },
      {
        createWorkerClient: () => Promise.resolve(workerClient),
        createRunTracker,
        runtimeEnvironmentOrchestrator: {
          launch: vi.fn(() => Promise.reject(new Error("Not used"))),
        },
        agentRunner: {
          promptAsync: vi.fn(() => Promise.reject(new Error("Not used"))),
          getSessionStatus: vi.fn(() => Promise.resolve({ running: false })),
          sendRetryPrompt: vi.fn(() => Promise.resolve(undefined)),
        },
        sleep: (milliseconds) => {
          sleepCalls.push(milliseconds);
          return Promise.resolve(undefined);
        },
        createWorkSignalClient: () => ({
          start: () => Promise.resolve(true),
          wake: () => new Promise<void>(() => {}),
          isConnected: () => true,
          disconnected: () => new Promise<void>(() => {}),
          stop,
        }),
        logger: { debug: vi.fn(), log: vi.fn(), error: vi.fn() },
      },
    );
    throw new Error("expected processProjectWork to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(StopPolling);
  }

  expect(stop).toHaveBeenCalledTimes(1);
  return sleepCalls;
}

describe("connected safety-net poll", () => {
  test("defaults to a 60-minute safety-net poll while the work signal is connected", async () => {
    expect(await runUntilStopped({})).toEqual(Array(10).fill(3_600_000));
  });

  test("reads SCARN_WORK_CONNECTED_MAX_POLL_INTERVAL_MS", async () => {
    process.env["SCARN_WORK_CONNECTED_MAX_POLL_INTERVAL_MS"] = "700000";

    expect(await runUntilStopped({})).toEqual(Array(10).fill(700_000));
  });

  test("the option overrides the env var", async () => {
    process.env["SCARN_WORK_CONNECTED_MAX_POLL_INTERVAL_MS"] = "700000";

    const sleepCalls = await runUntilStopped({
      connectedMaxPollIntervalMs: 900_000,
    });

    expect(sleepCalls).toEqual(Array(10).fill(900_000));
  });
});

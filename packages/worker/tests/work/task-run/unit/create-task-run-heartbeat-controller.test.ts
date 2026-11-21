import { describe, expect, test, vi } from "bun:test";
import { parseUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { createTaskRunHeartbeatController } from "../../../../src/work/task-run/application/create-task-run-heartbeat-controller";
import { isTaskRunCancelledResponse } from "../../../../src/work/task-run/application/task-run-cancelled-error";
import type { ManagedAuthorityAbortReason } from "../../../../src/work/task-run/application/managed-authority-lost-error";
import type { TaskRunWorkerClient } from "../../../../src/work/task-run/contracts/process-project-work-types";

const TASK_RUN_ID = parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe003");

function problem(status: number): Error {
  return new Error(
    JSON.stringify({ type: "about:blank", title: "x", status, code: "X" }),
  );
}

async function waitUntil(
  condition: () => boolean,
  maxTicks = 200,
): Promise<void> {
  for (let i = 0; i < maxTicks && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function startController(
  heartbeatTaskRun: TaskRunWorkerClient["heartbeatTaskRun"],
  options: {
    leaseDurationSeconds?: number;
    abortManagedAuthorityLost?: (reason: ManagedAuthorityAbortReason) => void;
    abortCancelled?: () => void;
  } = {},
) {
  const client = { heartbeatTaskRun } as unknown as TaskRunWorkerClient;
  return createTaskRunHeartbeatController(
    client,
    {
      sleep: () => Promise.resolve(),
      logger: { debug: vi.fn(), log: vi.fn(), error: vi.fn() },
    },
    {
      taskRunId: TASK_RUN_ID,
      claimToken: "claim",
      leaseDurationSeconds: options.leaseDurationSeconds ?? 0,
      run: {
        abortManagedAuthorityLost: options.abortManagedAuthorityLost ?? vi.fn(),
        abortCancelled: options.abortCancelled ?? vi.fn(),
      },
    },
  );
}

describe("createTaskRunHeartbeatController", () => {
  test.each([404, 409])(
    "a %d heartbeat marks the run cancelled and stops the loop",
    async (status) => {
      const heartbeatTaskRun = vi.fn(() => Promise.reject(problem(status)));
      const controller = startController(heartbeatTaskRun);

      await waitUntil(() => controller.isCancelled());

      expect(controller.isCancelled()).toBe(true);
      await controller.stop();
      expect(heartbeatTaskRun).toHaveBeenCalledTimes(1);
    },
  );

  test("a 200 with a non-running status marks the run cancelled and stops the loop", async () => {
    const heartbeatTaskRun = vi.fn(() =>
      Promise.resolve({
        status: "timeout" as const,
        managedAuthority: "ok" as const,
      }),
    );
    const controller = startController(heartbeatTaskRun);

    await waitUntil(() => controller.isCancelled());

    expect(controller.isCancelled()).toBe(true);
    expect(controller.lastKnownStatus()).toBe("timeout");
    await controller.stop();
    expect(heartbeatTaskRun).toHaveBeenCalledTimes(1);
  });

  test.each([404, 409])(
    "a %d heartbeat aborts the run as cancelled, so a call in flight stops",
    async (status) => {
      const abortCancelled = vi.fn();
      const controller = startController(
        vi.fn(() => Promise.reject(problem(status))),
        { abortCancelled },
      );

      await waitUntil(() => controller.isCancelled());
      await controller.stop();

      expect(abortCancelled).toHaveBeenCalledTimes(1);
    },
  );

  test.each(["cancelled", "timeout", "failed"] as const)(
    "a 200 with status %s aborts the run as cancelled",
    async (status) => {
      const abortCancelled = vi.fn();
      const controller = startController(
        vi.fn(() =>
          Promise.resolve({ status, managedAuthority: "ok" as const }),
        ),
        { abortCancelled },
      );

      await waitUntil(() => controller.isCancelled());
      await controller.stop();

      expect(abortCancelled).toHaveBeenCalledTimes(1);
    },
  );

  test.each(["succeeded", "yielded"] as const)(
    "a 200 with status %s, which the worker reported itself, aborts nothing",
    async (status) => {
      const abortCancelled = vi.fn();
      const controller = startController(
        vi.fn(() =>
          Promise.resolve({ status, managedAuthority: "ok" as const }),
        ),
        { abortCancelled },
      );

      await waitUntil(() => controller.isCancelled());
      await controller.stop();

      expect(abortCancelled).not.toHaveBeenCalled();
    },
  );

  test("a 200 with status running keeps the loop going", async () => {
    const heartbeatTaskRun = vi.fn(() =>
      Promise.resolve({
        status: "running" as const,
        managedAuthority: "ok" as const,
      }),
    );
    const controller = startController(heartbeatTaskRun);

    await waitUntil(() => heartbeatTaskRun.mock.calls.length >= 2, 600);
    await controller.stop();

    expect(heartbeatTaskRun.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(controller.isCancelled()).toBe(false);
    expect(controller.lastKnownStatus()).toBe("running");
  });

  test("a transient failure is not a cancellation", async () => {
    const heartbeatTaskRun = vi.fn(() =>
      Promise.reject(new Error("socket hang up")),
    );
    const controller = startController(heartbeatTaskRun);

    await waitUntil(() => heartbeatTaskRun.mock.calls.length >= 1);
    await controller.stop();

    expect(heartbeatTaskRun).toHaveBeenCalled();
    expect(controller.isCancelled()).toBe(false);
  });

  test("a heartbeat reporting lost managed authority aborts the run with its reason and keeps the lease alive", async () => {
    const heartbeatTaskRun = vi.fn(() =>
      Promise.resolve({
        status: "running" as const,
        managedAuthority: { lost: "disconnected" as const },
      }),
    );
    const abortManagedAuthorityLost = vi.fn();
    const controller = startController(heartbeatTaskRun, {
      abortManagedAuthorityLost,
    });

    await waitUntil(() => heartbeatTaskRun.mock.calls.length >= 2, 600);
    await controller.stop();

    expect(abortManagedAuthorityLost).toHaveBeenCalledWith("disconnected");
    expect(controller.isCancelled()).toBe(false);
  });

  test("an armed watchdog aborts with control_lost once heartbeats have failed for a whole lease", async () => {
    const heartbeatTaskRun = vi.fn(() =>
      Promise.reject(new Error("socket hang up")),
    );
    const abortManagedAuthorityLost = vi.fn();
    const controller = startController(heartbeatTaskRun, {
      leaseDurationSeconds: 1,
      abortManagedAuthorityLost,
    });
    controller.armManagedWatchdog();

    await waitUntil(() => abortManagedAuthorityLost.mock.calls.length > 0, 400);
    await controller.stop();

    expect(abortManagedAuthorityLost).toHaveBeenCalledTimes(1);
    expect(abortManagedAuthorityLost).toHaveBeenCalledWith("control_lost");
  });

  test("without an armed watchdog, failing heartbeats never abort the run", async () => {
    const heartbeatTaskRun = vi.fn(() =>
      Promise.reject(new Error("socket hang up")),
    );
    const abortManagedAuthorityLost = vi.fn();
    const controller = startController(heartbeatTaskRun, {
      leaseDurationSeconds: 1,
      abortManagedAuthorityLost,
    });

    await waitUntil(() => heartbeatTaskRun.mock.calls.length >= 2, 600);
    await controller.stop();

    expect(abortManagedAuthorityLost).not.toHaveBeenCalled();
  });

  test("stopping the loop disarms the watchdog", async () => {
    const abortManagedAuthorityLost = vi.fn();
    const controller = startController(
      vi.fn(() => Promise.reject(new Error("socket hang up"))),
      { leaseDurationSeconds: 1, abortManagedAuthorityLost },
    );
    controller.armManagedWatchdog();

    await controller.stop();
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    expect(abortManagedAuthorityLost).not.toHaveBeenCalled();
  });
});

describe("isTaskRunCancelledResponse", () => {
  test("recognises 404 and 409 problem details only", () => {
    expect(isTaskRunCancelledResponse(problem(404))).toBe(true);
    expect(isTaskRunCancelledResponse(problem(409))).toBe(true);
    expect(isTaskRunCancelledResponse(problem(500))).toBe(false);
    expect(isTaskRunCancelledResponse(new Error("404"))).toBe(false);
    expect(isTaskRunCancelledResponse("nope")).toBe(false);
  });
});

import { describe, expect, test, vi } from "bun:test";
import { parseUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { createTaskRunHeartbeatController } from "../../../../src/work/task-run/application/create-task-run-heartbeat-controller";
import { isTaskRunCancelledResponse } from "../../../../src/work/task-run/application/task-run-cancelled-error";
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
) {
  const client = { heartbeatTaskRun } as unknown as TaskRunWorkerClient;
  return createTaskRunHeartbeatController(
    client,
    {
      sleep: () => Promise.resolve(),
      logger: { debug: vi.fn(), log: vi.fn(), error: vi.fn() },
    },
    { taskRunId: TASK_RUN_ID, claimToken: "claim", leaseDurationSeconds: 0 },
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
      Promise.resolve({ status: "timeout" as const }),
    );
    const controller = startController(heartbeatTaskRun);

    await waitUntil(() => controller.isCancelled());

    expect(controller.isCancelled()).toBe(true);
    expect(controller.lastKnownStatus()).toBe("timeout");
    await controller.stop();
    expect(heartbeatTaskRun).toHaveBeenCalledTimes(1);
  });

  test("a 200 with status running keeps the loop going", async () => {
    const heartbeatTaskRun = vi.fn(() =>
      Promise.resolve({ status: "running" as const }),
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

import { describe, expect, test, vi } from "bun:test";
import { monitorStartedClaimedTaskRun } from "../../../../src/work/task-run/application/process-project-work-monitor";
import type { TaskRunStatus } from "../../../../src/work/task-run/contracts/task-run-contracts";
import {
  createHarness,
  createInput,
  createStartedTask,
  createTracker,
  createWorkspace,
  stopStub,
  writeExecutionInfo,
} from "./helpers/monitor-turn-end-harness";

async function setUp(input: {
  busyTicks: number;
  statuses: TaskRunStatus[];
  cancelledAfterSubmission?: boolean;
}) {
  const workspacePath = await createWorkspace();
  await writeExecutionInfo(workspacePath, {
    conversation: true,
    turnsRemaining: 0,
  });
  const startedTask = createStartedTask(workspacePath, () =>
    Promise.resolve({ pushed: true }),
  );
  const harness = createHarness(startedTask, { finalText: "Done." });
  let statusCall = 0;
  harness.deps.agentRunner.getSessionStatus = vi.fn(() => {
    statusCall += 1;
    return Promise.resolve({ running: statusCall <= input.busyTicks });
  });
  const statuses = [...input.statuses];
  const order: string[] = [];
  const getTaskRun = vi.fn(() => {
    order.push("getTaskRun");
    return Promise.resolve({ status: statuses.shift() ?? "succeeded" });
  });
  harness.deps.workerClient.getTaskRun = getTaskRun;
  harness.deps.sleep = vi.fn(() => {
    order.push("sleep");
    return Promise.resolve(undefined);
  });
  if (input.cancelledAfterSubmission) {
    startedTask.isCancelled = () =>
      harness.completeTaskRun.mock.calls.length > 0;
  }
  const tracker = createTracker();
  const run = () =>
    monitorStartedClaimedTaskRun(
      createInput(startedTask),
      harness.deps,
      tracker,
      startedTask,
      stopStub(),
      harness.logStream,
    );
  return { getTaskRun, harness, order, run, tracker };
}

describe("monitorStartedClaimedTaskRun — task run status reads", () => {
  test.concurrent(
    "reads the status once, after findings are submitted",
    async () => {
      const { getTaskRun, harness, run } = await setUp({
        busyTicks: 3,
        statuses: ["succeeded"],
      });

      await run();

      expect(getTaskRun).toHaveBeenCalledTimes(1);
      expect(harness.events.map((event) => event.type)).toContain(
        "task:succeeded",
      );
    },
  );

  test.concurrent(
    "sleeps before re-reading a status that is still running",
    async () => {
      const { getTaskRun, order, run } = await setUp({
        busyTicks: 1,
        statuses: ["running", "running", "succeeded"],
      });

      await run();

      expect(getTaskRun).toHaveBeenCalledTimes(3);
      const reads = order.slice(order.indexOf("getTaskRun"));
      expect(reads).toEqual([
        "getTaskRun",
        "sleep",
        "getTaskRun",
        "sleep",
        "getTaskRun",
      ]);
    },
  );

  test.concurrent(
    "finishes as succeeded when the heartbeat reports cancelled after submission",
    async () => {
      const { getTaskRun, harness, run, tracker } = await setUp({
        busyTicks: 1,
        statuses: ["succeeded"],
        cancelledAfterSubmission: true,
      });

      await run();

      expect(getTaskRun).toHaveBeenCalledTimes(1);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(tracker.markSucceeded).toHaveBeenCalled();
      expect(harness.events.map((event) => event.type)).toContain(
        "task:succeeded",
      );
    },
  );
});

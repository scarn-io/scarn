import { describe, expect, test, vi } from "bun:test";
import { monitorStartedClaimedTaskRun } from "../../../../src/work/task-run/application/process-project-work-monitor";
import { captureRejection } from "../../../support/capture-rejection";
import {
  createHarness,
  createInput,
  createStartedTask,
  createTracker,
  createWorkspace,
  writeExecutionInfo,
} from "./helpers/monitor-turn-end-harness";

async function setUp(input: { conversation: boolean }) {
  const workspacePath = await createWorkspace();
  await writeExecutionInfo(workspacePath, {
    conversation: input.conversation,
    turnsRemaining: 0,
  });
  const startedTask = createStartedTask(workspacePath, () =>
    Promise.resolve({ pushed: true }),
  );
  const harness = createHarness(startedTask, { finalText: "Done." });
  const order: string[] = [];
  const heartbeat = {
    stop: vi.fn(() => {
      order.push("heartbeat.stop");
      return Promise.resolve();
    }),
  };
  startedTask.environment.cleanup = vi.fn(() => {
    order.push("cleanup");
    return Promise.resolve();
  });
  const run = () =>
    monitorStartedClaimedTaskRun(
      { ...createInput(startedTask), preserveRuntimeOnComplete: false },
      harness.deps,
      createTracker(),
      startedTask,
      heartbeat,
      harness.logStream,
    );
  return { heartbeat, order, run };
}

describe("monitorStartedClaimedTaskRun — heartbeat", () => {
  test.concurrent(
    "stops the heartbeat, then cleans up, when the run succeeds",
    async () => {
      const { order, run } = await setUp({ conversation: true });

      await run();

      expect(order).toEqual(["heartbeat.stop", "cleanup"]);
    },
  );

  test.concurrent(
    "keeps the heartbeat running through cleanup when the run fails",
    async () => {
      const { heartbeat, order, run } = await setUp({ conversation: false });

      const failure = await captureRejection(run());

      expect(failure.message).toMatch(/without findings submission/);
      expect(heartbeat.stop).not.toHaveBeenCalled();
      expect(order).toEqual(["cleanup"]);
    },
  );
});

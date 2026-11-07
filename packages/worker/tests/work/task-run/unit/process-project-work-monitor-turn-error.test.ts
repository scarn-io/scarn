import { describe, expect, test } from "bun:test";
import { captureRejection } from "../../../support/capture-rejection";
import {
  createHarness,
  createStartedTask,
  createWorkspace,
  runMonitor,
  writeEndConversationMarker,
  writeExecutionInfo,
} from "./helpers/monitor-turn-end-harness";

const MODEL_NOT_FOUND =
  "provider.invalid-request: model_not_found: The 'gpt-6-sol' model is not supported";

async function startTask(input: {
  conversation: boolean;
  turnsRemaining: number | null;
}) {
  const workspacePath = await createWorkspace();
  await writeExecutionInfo(workspacePath, input);
  return {
    workspacePath,
    startedTask: createStartedTask(workspacePath, () =>
      Promise.resolve({ pushed: true }),
    ),
  };
}

describe("monitorStartedClaimedTaskRun — the agent's turn failed", () => {
  test.concurrent(
    "fails a conversation step with the turn's error instead of completing it",
    async () => {
      const { startedTask } = await startTask({
        conversation: true,
        turnsRemaining: null,
      });
      const harness = createHarness(startedTask, {
        finalText: "",
        turnError: MODEL_NOT_FOUND,
      });

      const failure = await captureRejection(runMonitor(startedTask, harness));

      expect(failure.message).toContain(MODEL_NOT_FOUND);
      expect(harness.completeTaskRun).not.toHaveBeenCalled();
    },
  );

  test.concurrent(
    "fails a step with a schema with the turn's error, not as missing findings",
    async () => {
      const { startedTask } = await startTask({
        conversation: false,
        turnsRemaining: null,
      });
      const harness = createHarness(startedTask, {
        finalText: "",
        turnError: MODEL_NOT_FOUND,
      });

      const failure = await captureRejection(runMonitor(startedTask, harness));

      expect(failure.message).toContain(MODEL_NOT_FOUND);
      expect(failure.message).not.toMatch(/without findings submission/);
    },
  );

  test.concurrent(
    "fails rather than hands over a partial message when turns are left",
    async () => {
      const { startedTask } = await startTask({
        conversation: true,
        turnsRemaining: 2,
      });
      const harness = createHarness(startedTask, {
        finalText: "Let me look at the",
        turnError: MODEL_NOT_FOUND,
      });

      const failure = await captureRejection(runMonitor(startedTask, harness));

      expect(failure.message).toContain(MODEL_NOT_FOUND);
      expect(harness.yieldTaskRun).not.toHaveBeenCalled();
    },
  );

  test.concurrent(
    "still ends a conversation the agent ended before the turn failed",
    async () => {
      const { workspacePath, startedTask } = await startTask({
        conversation: true,
        turnsRemaining: 2,
      });
      await writeEndConversationMarker(workspacePath);
      const harness = createHarness(startedTask, {
        finalText: "All done.",
        turnError: MODEL_NOT_FOUND,
      });

      await runMonitor(startedTask, harness);

      expect(harness.completeTaskRun).toHaveBeenCalledWith(
        expect.objectContaining({ resultJson: { summary: "All done." } }),
      );
    },
  );
});

import { describe, expect, test, vi } from "bun:test";
import {
  buildEndConversationPath,
  CONVERSATION_LAST_TURN_PROMPT,
  FINDINGS_LAST_TURN_PROMPT,
} from "../../../../src/work/task-run/application/process-project-work-turn-end";
import { captureRejection } from "../../../support/capture-rejection";
import {
  createHarness,
  createStartedTask,
  createTracker,
  createWorkspace,
  exists,
  retryPromptTexts,
  runMonitor,
  TASK_ID,
  writeEndConversationMarker,
  writeExecutionInfo,
} from "./helpers/monitor-turn-end-harness";

describe("monitorStartedClaimedTaskRun — no turns left", () => {
  test.concurrent(
    "tells a step with a schema to submit findings, then takes the missing-findings path",
    async () => {
      const workspacePath = await createWorkspace();
      await writeExecutionInfo(workspacePath, {
        conversation: false,
        turnsRemaining: 0,
      });
      const startedTask = createStartedTask(workspacePath, () =>
        Promise.resolve({ pushed: true }),
      );
      const harness = createHarness(startedTask, { finalText: "Which env?" });

      const failure = await captureRejection(runMonitor(startedTask, harness));

      expect(failure.message).toMatch(/without findings submission/);
      expect(retryPromptTexts(harness)[0]).toBe(FINDINGS_LAST_TURN_PROMPT);
      expect(retryPromptTexts(harness)).not.toContain(
        CONVERSATION_LAST_TURN_PROMPT,
      );
      expect(harness.yieldTaskRun).not.toHaveBeenCalled();
    },
  );

  test.concurrent(
    "tells a conversation step it's the last turn, then ends it",
    async () => {
      const workspacePath = await createWorkspace();
      await writeExecutionInfo(workspacePath, {
        conversation: true,
        turnsRemaining: 0,
      });
      const startedTask = createStartedTask(workspacePath, () =>
        Promise.resolve({ pushed: true }),
      );
      const harness = createHarness(startedTask, { finalText: "Goodbye." });

      await runMonitor(startedTask, harness);

      expect(retryPromptTexts(harness)).toEqual([
        CONVERSATION_LAST_TURN_PROMPT,
      ]);
      expect(harness.yieldTaskRun).not.toHaveBeenCalled();
      expect(harness.completeTaskRun).toHaveBeenCalledWith(
        expect.objectContaining({ resultJson: { summary: "Goodbye." } }),
      );
    },
  );
});

describe("monitorStartedClaimedTaskRun — ending a conversation", () => {
  test.concurrent(
    "completes with the masked summary and saves no session, ahead of a hand-off",
    async () => {
      const workspacePath = await createWorkspace();
      await writeExecutionInfo(workspacePath, {
        conversation: true,
        turnsRemaining: 2,
      });
      await writeEndConversationMarker(workspacePath);
      const commitAndPush = vi.fn(() => Promise.resolve({ pushed: true }));
      const startedTask = createStartedTask(workspacePath, commitAndPush);
      const tracker = createTracker();
      const harness = createHarness(startedTask, {
        finalText: "Rotated hunter2. All done.",
      });

      await runMonitor(startedTask, harness, tracker);

      expect(harness.yieldTaskRun).not.toHaveBeenCalled();
      expect(commitAndPush).toHaveBeenCalledWith({
        result: { summary: "Rotated ***. All done." },
      });
      expect(harness.completeTaskRun).toHaveBeenCalledWith({
        taskRunId: TASK_ID,
        claimToken: "claim-token",
        resultJson: { summary: "Rotated ***. All done." },
        errorJson: null,
        workBranch: "scarn/task-1",
        createdFromBranch: "main",
        sessionRestored: null,
      });
      expect(harness.exportSession).not.toHaveBeenCalled();
      expect(harness.createSessionUploadUrl).not.toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(tracker.markSucceeded).toHaveBeenCalled();
      expect(harness.events).toContainEqual({
        type: "task:succeeded",
        taskRunId: TASK_ID,
      });
      expect(await exists(buildEndConversationPath(workspacePath))).toBe(false);
    },
  );

  test.concurrent(
    "ignores the end marker on a step with a schema",
    async () => {
      const workspacePath = await createWorkspace();
      await writeExecutionInfo(workspacePath, {
        conversation: false,
        turnsRemaining: 2,
      });
      await writeEndConversationMarker(workspacePath);
      const startedTask = createStartedTask(workspacePath, () =>
        Promise.resolve({ pushed: true }),
      );
      const harness = createHarness(startedTask, { finalText: "Which env?" });

      await runMonitor(startedTask, harness);

      expect(harness.completeTaskRun).not.toHaveBeenCalled();
      expect(harness.yieldTaskRun).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Which env?" }),
      );
    },
  );
});

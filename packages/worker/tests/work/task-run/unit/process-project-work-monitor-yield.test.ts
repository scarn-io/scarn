import { writeFile } from "node:fs/promises";
import { describe, expect, test, vi } from "bun:test";
import { buildFindingsSubmissionPath } from "../../../../src/work/task-run/application/process-project-work-findings";
import { FINDINGS_LAST_TURN_PROMPT } from "../../../../src/work/task-run/application/process-project-work-turn-end";
import type { StartedClaimedTask } from "../../../../src/work/task-run/contracts/process-project-work-types";
import { captureRejection } from "../../../support/capture-rejection";
import {
  createHarness,
  createStartedTask,
  createTracker,
  createWorkspace,
  retryPromptTexts,
  runMonitor,
  TASK_ID,
  writeExecutionInfo,
} from "./helpers/monitor-turn-end-harness";

describe("monitorStartedClaimedTaskRun — handing over", () => {
  test.concurrent(
    "hands over with the masked final message when turns remain",
    async () => {
      const workspacePath = await createWorkspace();
      await writeExecutionInfo(workspacePath, {
        conversation: false,
        turnsRemaining: 2,
      });
      const commitAndPush = vi.fn(() => Promise.resolve({ pushed: true }));
      const startedTask = createStartedTask(workspacePath, commitAndPush);
      const tracker = createTracker();
      const harness = createHarness(startedTask, {
        finalText: "Is the password hunter2 still valid?",
      });

      await runMonitor(startedTask, harness, tracker);

      expect(commitAndPush).toHaveBeenCalledWith({ yielded: true });
      expect(harness.yieldTaskRun).toHaveBeenCalledWith({
        taskRunId: TASK_ID,
        claimToken: "claim-token",
        message: "Is the password *** still valid?",
        workBranch: "scarn/task-1",
        createdFromBranch: "main",
        sessionObjectKey: null,
        sessionRestored: null,
      });
      expect(harness.completeTaskRun).not.toHaveBeenCalled();
      expect(harness.saveArtifact).not.toHaveBeenCalled();
      expect(harness.logStream.flush).toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(tracker.markSucceeded).toHaveBeenCalled();
      expect(harness.events).toContainEqual({
        type: "task:yielded",
        taskRunId: TASK_ID,
      });
    },
  );

  test.concurrent(
    "hands over with a null work branch when the push failed under warn",
    async () => {
      const workspacePath = await createWorkspace();
      await writeExecutionInfo(workspacePath, {
        conversation: true,
        turnsRemaining: 1,
      });
      const startedTask = createStartedTask(workspacePath, () =>
        Promise.resolve({ pushed: false }),
      );
      const harness = createHarness(startedTask, { finalText: "Which env?" });

      await runMonitor(startedTask, harness);

      expect(harness.yieldTaskRun).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Which env?", workBranch: null }),
      );
    },
  );

  test.concurrent(
    "hands over without a session key when saving the session fails, still reporting the restore",
    async () => {
      const workspacePath = await createWorkspace();
      await writeExecutionInfo(workspacePath, {
        conversation: false,
        turnsRemaining: 2,
      });
      const startedTask: StartedClaimedTask = {
        ...createStartedTask(workspacePath, () =>
          Promise.resolve({ pushed: true }),
        ),
        sessionRestored: true,
      };
      const harness = createHarness(startedTask, { finalText: "Which env?" });

      await runMonitor(startedTask, harness);

      expect(harness.yieldTaskRun).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionObjectKey: null,
          sessionRestored: true,
        }),
      );
      expect(harness.createSessionUploadUrl).not.toHaveBeenCalled();
    },
  );

  test.concurrent(
    "completes with the findings instead of handing over when findings were submitted",
    async () => {
      const workspacePath = await createWorkspace();
      await writeExecutionInfo(workspacePath, {
        conversation: false,
        turnsRemaining: 2,
      });
      await writeFile(
        buildFindingsSubmissionPath(workspacePath),
        `${JSON.stringify({ findingsJson: { summary: "done" } }, null, 2)}\n`,
        "utf8",
      );
      const commitAndPush = vi.fn(() => Promise.resolve({ pushed: true }));
      const startedTask: StartedClaimedTask = {
        ...createStartedTask(workspacePath, commitAndPush),
        sessionRestored: false,
      };
      const harness = createHarness(startedTask, { finalText: "Which env?" });

      await runMonitor(startedTask, harness);

      expect(harness.yieldTaskRun).not.toHaveBeenCalled();
      expect(harness.completeTaskRun).toHaveBeenCalledWith(
        expect.objectContaining({
          resultJson: { summary: "done" },
          sessionRestored: false,
        }),
      );
      expect(commitAndPush).toHaveBeenCalledWith({
        result: { summary: "done" },
      });
    },
  );

  test.concurrent(
    "falls through to the missing-findings retry when the final message is empty",
    async () => {
      const workspacePath = await createWorkspace();
      await writeExecutionInfo(workspacePath, {
        conversation: false,
        turnsRemaining: 2,
      });
      const startedTask = createStartedTask(workspacePath, () =>
        Promise.resolve({ pushed: true }),
      );
      const harness = createHarness(startedTask, { finalText: "" });

      const failure = await captureRejection(runMonitor(startedTask, harness));

      expect(failure.message).toMatch(/without findings submission/);
      expect(harness.sendRetryPrompt).toHaveBeenCalled();
      expect(harness.yieldTaskRun).not.toHaveBeenCalled();
    },
  );

  test.concurrent(
    "never hands over outside a run, taking the missing-findings path instead",
    async () => {
      const workspacePath = await createWorkspace();
      await writeExecutionInfo(workspacePath, {
        conversation: false,
        turnsRemaining: null,
      });
      const startedTask = createStartedTask(workspacePath, () =>
        Promise.resolve({ pushed: true }),
      );
      const harness = createHarness(startedTask, { finalText: "Which env?" });

      const failure = await captureRejection(runMonitor(startedTask, harness));

      expect(failure.message).toMatch(/without findings submission/);
      expect(harness.yieldTaskRun).not.toHaveBeenCalled();
      expect(retryPromptTexts(harness)).not.toContain(
        FINDINGS_LAST_TURN_PROMPT,
      );
    },
  );

  test.concurrent(
    "ends a conversation step outside a run after its first turn",
    async () => {
      const workspacePath = await createWorkspace();
      await writeExecutionInfo(workspacePath, {
        conversation: true,
        turnsRemaining: null,
      });
      const startedTask = createStartedTask(workspacePath, () =>
        Promise.resolve({ pushed: true }),
      );
      const harness = createHarness(startedTask, { finalText: "Hello!" });

      await runMonitor(startedTask, harness);

      expect(harness.yieldTaskRun).not.toHaveBeenCalled();
      expect(harness.completeTaskRun).toHaveBeenCalledWith(
        expect.objectContaining({ resultJson: { summary: "Hello!" } }),
      );
    },
  );
});

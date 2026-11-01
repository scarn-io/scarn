import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test, vi } from "bun:test";
import { WORK_ITEM_CHANGES_RELATIVE_PATH } from "@scarn/sdk/contracts/work-item-changes";
import { buildWaitForWorkPath } from "../../../../src/work/task-run/contracts/wait-for-work-marker";
import {
  createHarness,
  createStartedTask,
  createTracker,
  createWorkspace,
  runMonitor,
  TASK_ID,
  writeExecutionInfo,
} from "./helpers/monitor-turn-end-harness";

const BLOCK = {
  kind: "block",
  blockedWorkItemId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
  blockingWorkItemId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c",
};

describe("monitorStartedClaimedTaskRun — waiting on work", () => {
  test.concurrent(
    "yields with kind wait_for_work and the recorded changes when the marker exists",
    async () => {
      const workspacePath = await createWorkspace();
      await writeExecutionInfo(workspacePath, {
        conversation: false,
        turnsRemaining: 2,
      });
      await writeFile(buildWaitForWorkPath(workspacePath), "{}\n");
      const changesPath = path.join(
        workspacePath,
        WORK_ITEM_CHANGES_RELATIVE_PATH,
      );
      await mkdir(path.dirname(changesPath), { recursive: true });
      await writeFile(changesPath, JSON.stringify({ changes: [BLOCK] }));
      const commitAndPush = vi.fn(() => Promise.resolve({ pushed: true }));
      const startedTask = createStartedTask(workspacePath, commitAndPush);
      const harness = createHarness(startedTask, {
        finalText: "Waiting on the child.",
      });

      await runMonitor(startedTask, harness, createTracker());

      expect(commitAndPush).toHaveBeenCalledWith({ yielded: true });
      expect(harness.yieldTaskRun).toHaveBeenCalledWith({
        taskRunId: TASK_ID,
        claimToken: "claim-token",
        kind: "wait_for_work",
        workItemChanges: [BLOCK],
        workBranch: "scarn/task-1",
        createdFromBranch: "main",
        sessionObjectKey: null,
        sessionRestored: null,
      });
      expect(harness.completeTaskRun).not.toHaveBeenCalled();
      expect(
        await access(buildWaitForWorkPath(workspacePath)).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    },
  );
});

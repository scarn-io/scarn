import { describe, expect, test, vi } from "bun:test";
import { onRunEnded } from "@/tasks/task/application/on-run-ended";
import {
  startReadyWork,
  type StartReadyWorkDeps,
} from "@/tasks/task/application/start-ready-work";
import type { TaskRepo } from "@/tasks/task/application/task-repo";
import { retryTaskAttempt } from "@/tasks/task/domain/retry-task-attempt";
import { latestBaseCommit } from "@/tasks/task/domain/base-commit";
import type { TaskEntity } from "@/tasks/task/domain/task-entity";
import type { TaskRunRepo } from "@/tasks/task-run/application/task-run-repo";
import type { TaskRunEntity } from "@/tasks/task-run/domain/task-run-entity";
import type { WorkItemBlockRepo } from "@/work-items/work-item-block/application/work-item-block-repo";
import { fixedTimeProvider } from "tests/utils";
import { recordingWorkNotifier } from "tests/tasks/task-run/recording-work-notifier";
import { buildTask, LATER, NOW, setup, tx } from "./on-run-ended-fixtures";

const PINNED = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const REPINNED = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

const failedRun = (
  task: TaskEntity,
  number: number,
  baseCommit: string | null,
  reason: TaskRunEntity["reason"] = number === 1 ? "initial" : "retry",
): TaskRunEntity =>
  task
    .newRun({
      number,
      reason,
      status: "queued",
      baseBranch: "main",
      baseCommit,
      now: NOW,
    })
    .markRunning(NOW)
    .complete("failed", LATER, {
      resultJson: null,
      errorJson: { name: "MergeConflict", message: "boom" },
    });

describe("latestBaseCommit", () => {
  test.concurrent("is null when no run has pinned a commit", () => {
    const task = buildTask("failed");
    expect(latestBaseCommit([failedRun(task, 1, null)])).toBeNull();
  });

  test.concurrent(
    "is the latest pinned run's commit, skipping later unpinned runs, in any order",
    () => {
      const task = buildTask("failed");
      const runs = [
        failedRun(task, 3, null),
        failedRun(task, 1, PINNED),
        failedRun(task, 2, REPINNED),
      ];
      expect(latestBaseCommit(runs)).toBe(REPINNED);
    },
  );
});

describe("a new run copies the latest pinned base commit", () => {
  test.concurrent(
    "a person's retry pins a later run's commit when the first run never pinned",
    () => {
      const task = buildTask("failed");
      const first = failedRun(task, 1, null);
      const latest = failedRun(task, 2, PINNED);

      const retried = retryTaskAttempt(
        task,
        [latest, first],
        latest.id,
        false,
        LATER,
      );

      expect(retried.run).toMatchObject({
        number: 3,
        baseBranch: "main",
        baseCommit: PINNED,
      });
    },
  );

  test.concurrent(
    "an automatic retry keeps the commit of an earlier run when the failed run never pinned",
    async () => {
      const task = buildTask("running", null, [
        { on: ["MergeConflict"], maxAttempts: 2 },
      ]);
      const first = failedRun(task, 1, PINNED);
      const run = failedRun(task, 2, null);
      const { deps, created } = setup(task, [first, run]);

      await onRunEnded(run, deps, tx);

      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        number: 3,
        reason: "retry",
        baseCommit: PINNED,
      });
    },
  );

  test.concurrent(
    "an automatic retry of a first run that pinned before failing keeps its commit",
    async () => {
      const task = buildTask("running", null, [
        { on: ["MergeConflict"], maxAttempts: 1 },
      ]);
      const run = failedRun(task, 1, PINNED);
      const { deps, created } = setup(task, [run]);

      await onRunEnded(run, deps, tx);

      expect(created[0]).toMatchObject({ number: 2, baseCommit: PINNED });
    },
  );

  test.concurrent(
    "a Task freed from waiting for work continues from its latest pinned commit",
    async () => {
      const task = buildTask("waiting_for_work");
      const runs = [failedRun(task, 1, null), failedRun(task, 2, PINNED)];
      const { workNotifier } = recordingWorkNotifier();
      const created: TaskRunEntity[] = [];
      const deps: StartReadyWorkDeps = {
        taskRepo: {
          lockWaitingForWorkByWorkItemIds: vi.fn(() => Promise.resolve([task])),
          save: vi.fn((next: TaskEntity) => Promise.resolve(next)),
        } as unknown as TaskRepo,
        taskRunRepo: {
          listByTaskId: vi.fn(() => Promise.resolve(runs)),
          create: vi.fn((run: TaskRunEntity) => {
            created.push(run);
            return Promise.resolve(run);
          }),
        } as unknown as TaskRunRepo,
        workItemBlockRepo: {
          listIdsWithOpenBlockers: vi.fn(() => Promise.resolve([])),
        } as unknown as WorkItemBlockRepo,
        timeProvider: fixedTimeProvider(NOW),
        workNotifier,
      };
      const { workItemId } = task;
      if (workItemId === null) {
        throw new Error("Expected a work item Task");
      }

      await startReadyWork([workItemId], deps, tx);

      expect(created[0]).toMatchObject({
        number: 3,
        reason: "continuation",
        baseCommit: PINNED,
      });
    },
  );
});

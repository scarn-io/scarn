import { describe, expect, test } from "bun:test";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { onRunEnded } from "@/tasks/task/application/on-run-ended";
import { latestEnvironmentVersion } from "@/tasks/task/domain/environment-version";
import { retryTaskAttempt } from "@/tasks/task/domain/retry-task-attempt";
import type { TaskEntity } from "@/tasks/task/domain/task-entity";
import type { TaskRunEntity } from "@/tasks/task-run/domain/task-run-entity";
import { buildTask, LATER, NOW, setup, tx } from "./on-run-ended-fixtures";

const PINNED = createUuidV7();
const REPINNED = createUuidV7();

const failedRun = (
  task: TaskEntity,
  number: number,
  environmentVersionId: UuidV7 | null,
): TaskRunEntity =>
  task
    .newRun({
      number,
      reason: number === 1 ? "initial" : "retry",
      status: "queued",
      baseBranch: "main",
      environmentVersionId,
      now: NOW,
    })
    .markRunning(NOW)
    .complete("failed", LATER, {
      resultJson: null,
      errorJson: { name: "MergeConflict", message: "boom" },
    });

describe("latestEnvironmentVersion", () => {
  test.concurrent("is null when no run has pinned a version", () => {
    const task = buildTask("failed");
    expect(latestEnvironmentVersion([failedRun(task, 1, null)])).toBeNull();
  });

  test.concurrent(
    "is the latest pinned run's version, skipping later unpinned runs, in any order",
    () => {
      const task = buildTask("failed");
      expect(
        latestEnvironmentVersion([
          failedRun(task, 3, null),
          failedRun(task, 1, PINNED),
          failedRun(task, 2, REPINNED),
        ]),
      ).toBe(REPINNED);
    },
  );
});

describe("a retry keeps the environment version", () => {
  test.concurrent("a person's retry copies the latest pinned version", () => {
    const task = buildTask("failed");
    const first = failedRun(task, 1, PINNED);
    const latest = failedRun(task, 2, null);

    const retried = retryTaskAttempt(
      task,
      [latest, first],
      latest.id,
      false,
      LATER,
    );

    expect(retried.run?.environmentVersionId).toBe(PINNED);
  });

  test.concurrent(
    "an automatic retry copies the failed run's version",
    async () => {
      const task = buildTask("running", null, [
        { on: ["MergeConflict"], maxAttempts: 1 },
      ]);
      const run = failedRun(task, 1, PINNED);
      const { deps, created } = setup(task, [run]);

      await onRunEnded(run, deps, tx);

      expect(created[0]?.environmentVersionId).toBe(PINNED);
    },
  );
});

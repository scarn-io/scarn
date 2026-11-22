import { describe, expect, test } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { CoreValidationError } from "@/lib/errors";
import { retryTaskAttempt } from "@/tasks/task/domain/retry-task-attempt";
import { TaskEntity, type TaskStatus } from "@/tasks/task/domain/task-entity";
import type { TaskRunStatus } from "@/tasks/task-run/domain/task-run-entity";
import { retryTaskInputSchema } from "@/tasks/task/contracts/task-contracts";
import { buildTask, LATER, NOW } from "./on-run-ended-fixtures";

describe("a person's Task retry", () => {
  test.concurrent.each<TaskRunStatus>([
    "failed",
    "timeout",
    "abandoned",
    "cancelled",
  ])(
    "retries a %s run with the original instructions, base branch and a fresh session",
    (status) => {
      const task = buildTask(
        status === "cancelled" ? "cancelled" : "failed",
        4,
        [{ on: ["Scarn.All"], maxAttempts: 1 }],
      );
      const first = task.newRun({
        number: 1,
        reason: "initial",
        status: "failed",
        baseBranch: "main",
        now: NOW,
      });
      const latest = task.newRun({
        number: 2,
        reason: "retry",
        status,
        baseBranch: "different",
        now: NOW,
      });
      const retried = retryTaskAttempt(
        task,
        [latest, first],
        latest.id,
        true,
        LATER,
      );
      expect(retried.task).toMatchObject({
        id: task.id,
        status: "queued",
        resultJson: null,
        errorJson: null,
        retryJson: task.retryJson,
        maxTurns: 4,
        prompt: task.prompt,
      });
      expect(retried.run).toMatchObject({
        taskId: task.id,
        number: 3,
        reason: "retry",
        baseBranch: "main",
        inputJson: task.inputJson,
        status: "queued",
        kind: "agent",
        prompt: task.prompt,
        sessionObjectKey: null,
        sessionRestored: null,
        previousTaskRunId: null,
        claimedBy: null,
        claimToken: null,
      });
      expect(retried.run?.id).not.toBe(latest.id);
    },
  );

  test.concurrent.each<TaskStatus>([
    "waiting_for_work",
    "waiting_for_concurrency_slot",
    "waiting_for_person",
    "queued",
    "running",
    "succeeded",
  ])("rejects a %s Task", (status) => {
    const task = buildTask(status);
    const run = task.newRun({
      number: 1,
      reason: "initial",
      status: "failed",
      now: NOW,
    });
    expect(() => retryTaskAttempt(task, [run], run.id, false, LATER)).toThrow(
      CoreValidationError,
    );
  });

  test.concurrent.each<TaskRunStatus>([
    "failed",
    "timeout",
    "abandoned",
    "cancelled",
    "yielded",
  ])(
    "a cancelled Task with a %s latest run retries from the first base branch with a fresh session",
    (status) => {
      const task = buildTask("cancelled");
      const first = task.newRun({
        number: 1,
        reason: "initial",
        status: "yielded",
        baseBranch: "main",
        now: NOW,
      });
      const latest = task.newRun({
        number: 2,
        reason: "continuation",
        status,
        baseBranch: "previous-work",
        now: NOW,
      });
      const retried = retryTaskAttempt(
        task,
        [first, latest],
        latest.id,
        false,
        LATER,
      );
      expect(retried.task.status).toBe("queued");
      expect(retried.run).toMatchObject({
        number: 3,
        reason: "retry",
        baseBranch: "main",
        sessionObjectKey: null,
        sessionRestored: null,
        previousTaskRunId: null,
      });
    },
  );

  test.concurrent.each<TaskRunStatus>(["queued", "running", "succeeded"])(
    "rejects a cancelled Task with a %s latest run",
    (status) => {
      const task = buildTask("cancelled");
      const run = task.newRun({
        number: 1,
        reason: "initial",
        status,
        now: NOW,
      });
      expect(() => retryTaskAttempt(task, [run], run.id, false, LATER)).toThrow(
        CoreValidationError,
      );
    },
  );

  test.concurrent(
    "retry accepts cancellation while waiting for a person",
    () => {
      const task = buildTask("waiting_for_person");
      const yielded = task.newRun({
        number: 1,
        reason: "initial",
        status: "yielded",
        baseBranch: "main",
        now: NOW,
      });
      const cancelled = task.cancelWaiting(LATER);
      expect(yielded.status).toBe("yielded");
      const retried = retryTaskAttempt(
        cancelled,
        [yielded],
        yielded.id,
        false,
        LATER,
      );
      expect(retried.task.status).toBe("queued");
      expect(retried.run).toMatchObject({
        number: 2,
        reason: "retry",
        baseBranch: "main",
      });
    },
  );

  test.concurrent(
    "rejects a failed Task with a yielded latest run (max-turns failure)",
    () => {
      const task = buildTask("failed", 0);
      const run = task.newRun({
        number: 1,
        reason: "initial",
        status: "yielded",
        now: NOW,
      });
      expect(() => retryTaskAttempt(task, [run], run.id, false, LATER)).toThrow(
        CoreValidationError,
      );
    },
  );

  test.concurrent(
    "rejects a stale latest run, including a stale no-runs expectation",
    () => {
      const task = buildTask("failed");
      const run = task.newRun({
        number: 1,
        reason: "initial",
        status: "failed",
        now: NOW,
      });
      for (const expected of [null, createUuidV7()]) {
        expect(() =>
          retryTaskAttempt(task, [run], expected, false, LATER),
        ).toThrow("latest run changed");
      }
      expect(() =>
        retryTaskAttempt(buildTask("cancelled"), [], run.id, false, LATER),
      ).toThrow("latest run changed");
    },
  );

  test.concurrent.each([true, false])(
    "cancelled before any run honors blockers (%s)",
    (blocked) => {
      const task = buildTask("cancelled");
      const retried = retryTaskAttempt(task, [], null, blocked, LATER);
      expect(retried.task.status).toBe(blocked ? "waiting_for_work" : "queued");
      if (blocked) {
        expect(retried.run).toBeNull();
      } else {
        expect(retried.run).toMatchObject({
          number: 1,
          reason: "initial",
          baseBranch: null,
        });
      }
    },
  );

  test.concurrent(
    "a lapsed running Task can be retried before the next worker poll",
    () => {
      const task = buildTask("running");
      const run = task.newRun({
        number: 1,
        reason: "initial",
        status: "timeout",
        now: NOW,
      });
      expect(
        retryTaskAttempt(task, [run], run.id, false, LATER).task.status,
      ).toBe("queued");
    },
  );

  test.concurrent("code Tasks also keep their immutable instructions", () => {
    const task = TaskEntity.create({
      projectId: createUuidV7(),
      workItemId: createUuidV7(),
      kind: "code",
      entrypointJson: { sourceFile: "test.ts" },
      status: "failed",
      createdAt: NOW,
    });
    const run = task.newRun({
      number: 1,
      reason: "initial",
      status: "failed",
      now: NOW,
    });
    expect(
      retryTaskAttempt(task, [run], run.id, false, LATER).run,
    ).toMatchObject({
      kind: "code",
      entrypointJson: task.entrypointJson,
    });
  });

  test.concurrent("the contract requires the explicit latest-run guard", () => {
    const taskId = createUuidV7();
    expect(retryTaskInputSchema.safeParse({ taskId }).success).toBe(false);
    expect(
      retryTaskInputSchema.safeParse({ taskId, expectedLatestRunId: null })
        .success,
    ).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import { onRunEnded } from "@/tasks/task/application/on-run-ended";
import type { TaskEntity } from "@/tasks/task/domain/task-entity";
import type { TaskRunEntity } from "@/tasks/task-run/domain/task-run-entity";
import { buildTask, LATER, NOW, setup, tx } from "./on-run-ended-fixtures";

describe("onRunEnded: retries", () => {
  const RETRY = [{ on: ["MergeConflict"], maxAttempts: 1 }];

  const queuedRun = (
    task: TaskEntity,
    number: number,
    reason: TaskRunEntity["reason"],
    baseBranch: string | null = null,
  ) =>
    task
      .newRun({ number, reason, status: "queued", baseBranch, now: NOW })
      .markRunning(NOW);

  const fail = (run: TaskRunEntity, name = "MergeConflict") =>
    run.complete("failed", LATER, {
      resultJson: null,
      errorJson: { name, message: "boom" },
    });

  test.concurrent(
    "a failure the policy retries queues a retry run from the first run's base branch and keeps the engine out",
    async () => {
      const task = buildTask("running", null, RETRY);
      const run = fail(queuedRun(task, 1, "initial", "main"));
      const { deps, created, taskChanged, enqueued } = setup(task, [run]);

      const ended = await onRunEnded(run, deps, tx);

      expect(enqueued).toEqual([task.projectId]);
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        taskId: task.id,
        number: 2,
        reason: "retry",
        status: "queued",
        baseBranch: "main",
        inputJson: task.inputJson,
      });
      expect(ended.status).toBe("queued");
      expect(taskChanged).not.toHaveBeenCalled();
    },
  );

  test.concurrent(
    "a failure past maxAttempts fails the Task and tells the port",
    async () => {
      const task = buildTask("running", null, RETRY);
      const first = fail(queuedRun(task, 1, "initial"));
      const run = fail(queuedRun(task, 2, "retry"));
      const { deps, created, taskChanged, enqueued } = setup(task, [
        first,
        run,
      ]);

      const ended = await onRunEnded(run, deps, tx);

      expect(created).toEqual([]);
      expect(enqueued).toEqual([]);
      expect(ended).toMatchObject({
        status: "failed",
        errorJson: { name: "MergeConflict", message: "boom" },
      });
      expect(taskChanged).toHaveBeenCalledWith(ended, run, tx);
    },
  );

  test.concurrent(
    "an error the policy doesn't name fails the Task",
    async () => {
      const task = buildTask("running", null, RETRY);
      const run = fail(queuedRun(task, 1, "initial"), "Scarn.StepFailed");
      const { deps, created, taskChanged } = setup(task, [run]);

      const ended = await onRunEnded(run, deps, tx);

      expect(created).toEqual([]);
      expect(ended.status).toBe("failed");
      expect(taskChanged).toHaveBeenCalled();
    },
  );

  test.concurrent("a timeout is retried as Scarn.Timeout", async () => {
    const task = buildTask("running", null, [
      { on: ["Scarn.Timeout"], maxAttempts: 1 },
    ]);
    const run = queuedRun(task, 1, "initial").failWith(
      "timeout",
      { code: "TASK_TIMED_OUT" },
      LATER,
    );
    const { deps, created } = setup(task, [run]);

    const ended = await onRunEnded(run, deps, tx);

    expect(created).toHaveLength(1);
    expect(ended.status).toBe("queued");
  });

  test.concurrent(
    "earlier yields don't use up retries: yield, fail retries; yield, fail, retry, fail stops",
    async () => {
      const task = buildTask("running", 3, RETRY);
      const yielded = queuedRun(task, 1, "initial").yield(LATER, {
        message: "v1 or v2?",
      });
      const continued = fail(queuedRun(task, 2, "continuation"));
      const once = setup(task, [yielded, continued]);

      expect((await onRunEnded(continued, once.deps, tx)).status).toBe(
        "queued",
      );
      expect(once.created[0]).toMatchObject({ number: 3, reason: "retry" });

      const retried = fail(queuedRun(task, 3, "retry"));
      const twice = setup(task, [yielded, continued, retried]);

      expect((await onRunEnded(retried, twice.deps, tx)).status).toBe("failed");
      expect(twice.created).toEqual([]);
      expect(twice.taskChanged).toHaveBeenCalled();
    },
  );

  test.concurrent(
    "a yield past maxTurns is never retried, even under Scarn.All",
    async () => {
      const task = buildTask("running", 0, [
        { on: ["Scarn.All"], maxAttempts: 5 },
      ]);
      const run = queuedRun(task, 1, "initial").yield(LATER, {
        message: "v1 or v2?",
      });
      const { deps, created } = setup(task, [run]);

      const ended = await onRunEnded(run, deps, tx);

      expect(created).toEqual([]);
      expect(ended.errorJson).toMatchObject({
        name: "Scarn.MaxTurnsExceeded",
      });
    },
  );

  test.concurrent(
    "a failed run that isn't the Task's latest queues nothing",
    async () => {
      const task = buildTask("running", null, RETRY);
      const run = fail(queuedRun(task, 1, "initial"));
      const later = queuedRun(task, 2, "retry");
      const { deps, created, saved, taskChanged } = setup(task, [run, later]);

      await onRunEnded(run, deps, tx);

      expect(created).toEqual([]);
      expect(saved).toEqual([]);
      expect(deps.taskGroup.ended).not.toHaveBeenCalled();
      expect(taskChanged).not.toHaveBeenCalled();
    },
  );
});

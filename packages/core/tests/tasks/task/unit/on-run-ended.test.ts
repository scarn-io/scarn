import { describe, expect, test } from "bun:test";
import { onRunEnded } from "@/tasks/task/application/on-run-ended";
import type { TaskEntity } from "@/tasks/task/domain/task-entity";
import { turnsLeft } from "@/tasks/task/domain/task-turns";
import type { TaskRunEntity } from "@/tasks/task-run/domain/task-run-entity";
import {
  buildTask,
  LATER,
  NOW,
  runningRun,
  setup,
  tx,
} from "./on-run-ended-fixtures";

describe("onRunEnded", () => {
  test.concurrent(
    "a succeeded run makes the Task succeeded with its result",
    async () => {
      const task = buildTask();
      const run = runningRun(task).complete("succeeded", LATER, {
        resultJson: { fixed: true },
      });
      const { deps, taskChanged } = setup(task);

      const ended = await onRunEnded(run, deps, tx);

      expect(ended).toMatchObject({
        status: "succeeded",
        resultJson: { fixed: true },
        errorJson: null,
        updatedAt: LATER,
      });
      expect(taskChanged).toHaveBeenCalledWith(ended, run, tx);
    },
  );

  test.concurrent(
    "a yielded run makes the Task wait for a person in its conversation",
    async () => {
      const task = buildTask();
      const run = runningRun(task).yield(LATER, { message: "v1 or v2?" });
      const { deps, taskChanged, yielded, insertMessage } = setup(task);

      const ended = await onRunEnded(run, deps, tx, yielded);

      expect(ended.status).toBe("waiting_for_person");
      expect(ended.conversationId).not.toBeNull();
      expect(insertMessage).toHaveBeenCalledTimes(1);
      expect(taskChanged).toHaveBeenCalledWith(ended, run, tx);
    },
  );

  test.concurrent(
    "a hand-over without its final message is an invariant violation",
    async () => {
      const task = buildTask();
      const run = runningRun(task).yield(LATER, { message: "v1 or v2?" });
      const { deps } = setup(task);

      let message = "resolved";
      try {
        await onRunEnded(run, deps, tx);
      } catch (caught) {
        message = caught instanceof Error ? caught.message : String(caught);
      }
      expect(message).toContain("handed over without its final message");
    },
  );

  test.concurrent.each([
    [
      "failed",
      (run: TaskRunEntity) =>
        run.complete("failed", LATER, {
          resultJson: null,
          errorJson: { name: "MergeConflict" },
        }),
    ],
    [
      "timeout",
      (run: TaskRunEntity) =>
        run.failWith("timeout", { name: "MergeConflict" }, LATER),
    ],
    [
      "abandoned",
      (run: TaskRunEntity) =>
        run.failWith("abandoned", { name: "MergeConflict" }, LATER),
    ],
  ] as const)(
    "a %s run makes the Task failed with its named error",
    async (status, end) => {
      const task = buildTask();
      const run = end(runningRun(task));
      const { deps, taskChanged } = setup(task);

      const ended = await onRunEnded(run, deps, tx);

      expect(ended).toMatchObject({
        status: "failed",
        resultJson: null,
        errorJson: {
          name:
            status === "timeout"
              ? "Scarn.Timeout"
              : status === "abandoned"
                ? "Scarn.HeartbeatTimeout"
                : "MergeConflict",
        },
      });
      expect(taskChanged).toHaveBeenCalledWith(ended, run, tx);
    },
  );

  test.concurrent("a cancelled run makes the Task cancelled", async () => {
    const task = buildTask();
    const run = runningRun(task).withStatus("cancelled", LATER, {
      completedAt: LATER,
      clearClaim: true,
    });
    const { deps, taskChanged } = setup(task);

    const ended = await onRunEnded(run, deps, tx);

    expect(ended.status).toBe("cancelled");
    expect(taskChanged).toHaveBeenCalledWith(ended, run, tx);
  });

  test.concurrent(
    "a run that leaves the Task's status as it was saves nothing and tells no one",
    async () => {
      const task = buildTask("cancelled");
      const run = runningRun(task).withStatus("cancelled", LATER, {
        completedAt: LATER,
        clearClaim: true,
      });
      const { deps, saved, taskChanged } = setup(task);

      const ended = await onRunEnded(run, deps, tx);

      expect(ended).toBe(task);
      expect(saved).toEqual([]);
      expect(taskChanged).not.toHaveBeenCalled();
    },
  );

  test.concurrent("a queued run puts an ended Task back in the queue", () => {
    const task = buildTask("failed");
    const run = task.newRun({
      number: 2,
      reason: "retry",
      status: "queued",
      now: LATER,
    });

    expect(task.followRun(run, LATER).status).toBe("queued");
    expect(task.followRun(run.markRunning(LATER), LATER).status).toBe(
      "running",
    );
  });

  test.concurrent("a run of another Task is rejected", () => {
    const run = runningRun(buildTask()).complete("succeeded", LATER, {
      resultJson: null,
    });

    expect(() => buildTask().followRun(run, LATER)).toThrow(
      "is not a run of Task",
    );
  });
});

describe("turnsLeft", () => {
  test.concurrent.each([
    [2, 0, 2],
    [2, 1, 1],
    [2, 2, 0],
    [2, 3, 0],
    [0, 0, 0],
  ])(
    "maxTurns %i with %i continuation runs leaves %i",
    (maxTurns, continuationRuns, left) => {
      expect(turnsLeft({ maxTurns }, continuationRuns)).toBe(left);
    },
  );

  test.concurrent("a Task with no maxTurns has no turns", () => {
    expect(turnsLeft({ maxTurns: null }, 3)).toBeNull();
  });
});

describe("onRunEnded: a yield with no turns left", () => {
  const runsUpTo = (task: TaskEntity, continuations: number) => {
    const runs = Array.from({ length: continuations + 1 }, (_, index) =>
      task.newRun({
        number: index + 1,
        reason: index === 0 ? "initial" : "continuation",
        status: "queued",
        now: NOW,
      }),
    );
    const latest = runs[runs.length - 1];
    if (!latest) {
      throw new Error("no runs");
    }
    return { runs, latest };
  };

  test.concurrent(
    "the last turn's yield makes the Task wait for a person",
    async () => {
      const task = buildTask("running", 2);
      const { runs, latest } = runsUpTo(task, 1);
      const run = latest.markRunning(NOW).yield(LATER, {
        message: "v1 or v2?",
      });
      const { deps, taskChanged, yielded } = setup(task, runs);

      const ended = await onRunEnded(run, deps, tx, yielded);

      expect(ended.status).toBe("waiting_for_person");
      expect(taskChanged).toHaveBeenCalledWith(ended, run, tx);
    },
  );

  test.concurrent(
    "a yield past maxTurns fails the Task with Scarn.MaxTurnsExceeded",
    async () => {
      const task = buildTask("running", 2);
      const { runs, latest } = runsUpTo(task, 2);
      const run = latest.markRunning(NOW).yield(LATER, {
        message: "v1 or v2?",
      });
      const { deps, taskChanged } = setup(task, runs);

      const ended = await onRunEnded(run, deps, tx);

      expect(ended).toMatchObject({
        status: "failed",
        resultJson: null,
        errorJson: {
          name: "Scarn.MaxTurnsExceeded",
          message: '"Propose fix" can\'t hand over more than 2 times',
        },
      });
      expect(taskChanged).toHaveBeenCalledWith(ended, run, tx);
    },
  );

  test.concurrent(
    "with maxTurns 0 the first yield fails the Task",
    async () => {
      const task = buildTask("running", 0);
      const run = runningRun(task).yield(LATER, { message: "v1 or v2?" });
      const { deps } = setup(task, [run]);

      const ended = await onRunEnded(run, deps, tx);

      expect(ended.status).toBe("failed");
      expect(ended.errorJson).toMatchObject({
        name: "Scarn.MaxTurnsExceeded",
      });
    },
  );

  test.concurrent(
    "a Task with no maxTurns always waits after a yield",
    async () => {
      const task = buildTask("running", null);
      const run = runningRun(task).yield(LATER, { message: "v1 or v2?" });
      const { deps, yielded } = setup(task);

      const ended = await onRunEnded(run, deps, tx, yielded);

      expect(ended.status).toBe("waiting_for_person");
      expect(deps.taskRunRepo.listByTaskId).toHaveBeenCalledWith(task.id, tx);
    },
  );
});

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import type {
  TaskActionClient,
  TaskDetail,
  TaskRunDetail,
} from "@scarn/shared-core";
import { createTasksCommand } from "../src/commands/tasks";
import type { CliError } from "../src/lib/cli-error";
import {
  fail,
  fakeIo,
  ok,
  rejection,
  runAction,
  unusedReads,
  type FakeIo,
} from "./action-harness";

setDefaultTimeout(15_000);

const TASK_ID = "0196a000-0000-7000-8000-0000000000c1";
const PIPELINE_RUN_ID = "0196a000-0000-7000-8000-0000000000bb";

const task = {
  id: TASK_ID,
  status: "failed",
  pipelineRunId: null,
  nodeId: null,
} as unknown as TaskDetail;

const run = (id: string, number: number) =>
  ({ id, number }) as unknown as TaskRunDetail;

type Calls = { retries: unknown[]; cancels: string[] };

function setup(io: FakeIo, overrides: Partial<TaskActionClient["tasks"]> = {}) {
  const calls: Calls = { retries: [], cancels: [] };
  const client: TaskActionClient = {
    tasks: {
      getTask: () => ok(task),
      getTaskRuns: () => ok([run("run-2", 2), run("run-1", 1)]),
      retryTask: ({ path, body }) => {
        calls.retries.push({ path, body });
        return ok({ taskId: path.taskId, taskRunId: "run-3" });
      },
      cancelTask: ({ path }) => {
        calls.cancels.push(path.taskId);
        return ok({ taskId: path.taskId });
      },
      ...overrides,
    },
  };
  const command = createTasksCommand(unusedReads, {
    connect: () =>
      Promise.resolve({ client, headers: { Authorization: "Bearer t" } }),
    io,
  });
  return {
    calls,
    run: (args: readonly string[]) => runAction(command, ["tasks", ...args]),
  };
}

describe("scarn tasks retry", () => {
  test("sends the latest run's id without asking and hints at view and logs", async () => {
    const io = fakeIo();
    const { calls, run: runTasks } = setup(io);

    const stdout = await runTasks(["retry", TASK_ID]);

    expect(io.asked).toEqual([]);
    expect(calls.retries).toEqual([
      { path: { taskId: TASK_ID }, body: { expectedLatestRunId: "run-2" } },
    ]);
    expect(stdout).toContain(`Retried Task ${TASK_ID} as Task run run-3.`);
    expect(stdout).toContain(`→ scarn tasks view ${TASK_ID}`);
    expect(stdout).toContain("→ scarn logs run-3 --follow");
  });

  test("a Task with no runs sends null", async () => {
    const { calls, run: runTasks } = setup(fakeIo(), {
      getTaskRuns: () => ok([]),
    });

    await runTasks(["retry", TASK_ID]);

    expect(calls.retries).toEqual([
      { path: { taskId: TASK_ID }, body: { expectedLatestRunId: null } },
    ]);
  });

  test("a pipeline step's Task points at runs rerun instead", async () => {
    const { calls, run: runTasks } = setup(fakeIo(), {
      getTask: () =>
        ok({ ...task, pipelineRunId: PIPELINE_RUN_ID, nodeId: "build" }),
    });

    const error = await rejection(runTasks(["retry", TASK_ID]));

    expect((error as CliError).code).toBe("action_rejected");
    expect(error.message).toContain(
      `scarn runs rerun ${PIPELINE_RUN_ID} --step build`,
    );
    expect(calls.retries).toEqual([]);
  });

  test("a stale retry (409) is action_conflict", async () => {
    const { run: runTasks } = setup(fakeIo(), {
      retryTask: () => fail(409, "The Task's latest run changed."),
    });

    const error = await rejection(runTasks(["retry", TASK_ID]));

    expect((error as CliError).code).toBe("action_conflict");
    expect(error.message).toBe(
      `Could not retry Task ${TASK_ID}: The Task's latest run changed.`,
    );
  });

  test("an unknown Task is action_not_found", async () => {
    const { run: runTasks } = setup(fakeIo(), {
      getTask: () => fail(404, "Task not found"),
    });

    const error = await rejection(runTasks(["retry", TASK_ID]));

    expect((error as CliError).code).toBe("action_not_found");
  });
});

describe("scarn tasks cancel", () => {
  test("--yes cancels and hints at tasks view", async () => {
    const { calls, run: runTasks } = setup(fakeIo());

    const stdout = await runTasks(["cancel", TASK_ID, "--yes"]);

    expect(calls.cancels).toEqual([TASK_ID]);
    expect(stdout).toContain(`→ scarn tasks view ${TASK_ID}`);
  });

  test("warns that a pipeline step's Task cancels the whole run", async () => {
    const io = fakeIo({ answer: false });
    const { calls, run: runTasks } = setup(io, {
      getTask: () => ok({ ...task, pipelineRunId: PIPELINE_RUN_ID }),
    });

    await runTasks(["cancel", TASK_ID]);

    expect(io.asked[0]).toContain("the whole run is cancelled");
    expect(calls.cancels).toEqual([]);
  });

  test("an already-ended Task (422) is action_rejected", async () => {
    const { run: runTasks } = setup(fakeIo(), {
      cancelTask: () => fail(422, "The Task already ended."),
    });

    const error = await rejection(runTasks(["cancel", TASK_ID, "--yes"]));

    expect((error as CliError).code).toBe("action_rejected");
  });
});

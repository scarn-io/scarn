import { describe, expect, setDefaultTimeout, test } from "bun:test";
import type {
  TaskAccessClient,
  TaskActionClient,
  TaskDetail,
  TaskGrantRequest,
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

const pendingRequest: TaskGrantRequest = {
  id: "request-1",
  taskId: TASK_ID,
  taskRunId: "run-2",
  reason: "I need to file the follow-ups.",
  requested: [
    { resource: "workItem", action: "comment", scope: "self" },
    {
      resource: "workItem",
      action: "create",
      scope: "children",
      labels: ["bug", "chore"],
    },
  ],
  status: "pending",
  approved: null,
  note: null,
  decidedByUserId: null,
  decidedAt: null,
  createdAt: "2026-01-02T00:02:00.000Z",
};

type Calls = { retries: unknown[]; cancels: string[]; decisions: unknown[] };

type Client = TaskActionClient & TaskAccessClient;

function setup(io: FakeIo, overrides: Partial<Client["tasks"]> = {}) {
  const calls: Calls = { retries: [], cancels: [], decisions: [] };
  const client: Client = {
    tasks: {
      listTaskGrantRequests: () => ok([pendingRequest]),
      decideTaskGrantRequest: (options) => {
        calls.decisions.push(options);
        return ok({});
      },
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
    connect: () => Promise.resolve({ client }),
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

describe("scarn tasks access", () => {
  test("--approve approves every requested grant as requested", async () => {
    const { calls, run: runTasks } = setup(fakeIo());

    const stdout = await runTasks(["access", TASK_ID, "--approve"]);

    expect(calls.decisions).toEqual([
      {
        path: { grantRequestId: "request-1" },
        body: { approved: pendingRequest.requested },
      },
    ]);
    expect(stdout).toContain(
      `Approved 2 of 2 requested grants for Task ${TASK_ID}`,
    );
    expect(stdout.trimEnd().endsWith(`→ scarn tasks view ${TASK_ID}`)).toBe(
      true,
    );
  });

  test("--only and --labels approve a subset, with the note", async () => {
    const { calls, run: runTasks } = setup(fakeIo());

    await runTasks([
      "access",
      TASK_ID,
      "--approve",
      "--only",
      "create:children",
      "--labels",
      "bug",
      "--note",
      "Just bugs, please.",
    ]);

    expect(calls.decisions).toEqual([
      {
        path: { grantRequestId: "request-1" },
        body: {
          approved: [
            {
              resource: "workItem",
              action: "create",
              scope: "children",
              labels: ["bug"],
            },
          ],
          note: "Just bugs, please.",
        },
      },
    ]);
  });

  test("--deny approves nothing", async () => {
    const { calls, run: runTasks } = setup(fakeIo());

    const stdout = await runTasks(["access", TASK_ID, "--deny"]);

    expect(calls.decisions).toEqual([
      { path: { grantRequestId: "request-1" }, body: { approved: [] } },
    ]);
    expect(stdout).toContain(`Denied the access request of Task ${TASK_ID}`);
  });

  test("needs exactly one of --approve and --deny", async () => {
    const { calls, run: runTasks } = setup(fakeIo());

    for (const flags of [[], ["--approve", "--deny"]]) {
      const error = await rejection(runTasks(["access", TASK_ID, ...flags]));
      expect((error as CliError).code).toBe("invalid_usage");
    }
    expect(calls.decisions).toEqual([]);
  });

  test("a selector or label the request lacks is refused before deciding", async () => {
    const { calls, run: runTasks } = setup(fakeIo());

    const selector = await rejection(
      runTasks(["access", TASK_ID, "--approve", "--only", "close:self"]),
    );
    const label = await rejection(
      runTasks(["access", TASK_ID, "--approve", "--labels", "feature"]),
    );

    expect((selector as CliError).code).toBe("action_rejected");
    expect(selector.message).toContain("doesn't ask for close:self");
    expect((label as CliError).code).toBe("action_rejected");
    expect(label.message).toContain("got feature");
    expect(calls.decisions).toEqual([]);
  });

  test("no pending request is action_conflict", async () => {
    const { run: runTasks } = setup(fakeIo(), {
      listTaskGrantRequests: () =>
        ok([{ ...pendingRequest, status: "unanswered" }]),
    });

    const error = await rejection(runTasks(["access", TASK_ID, "--approve"]));

    expect((error as CliError).code).toBe("action_conflict");
    expect(error.message).toBe(
      `Task ${TASK_ID} has no pending access request.`,
    );
  });

  test("API refusals map to action_conflict and action_forbidden", async () => {
    for (const [status, code] of [
      [409, "action_conflict"],
      [403, "action_forbidden"],
    ] as const) {
      const { run: runTasks } = setup(fakeIo(), {
        decideTaskGrantRequest: () => fail(status, "refused"),
      });

      const error = await rejection(runTasks(["access", TASK_ID, "--deny"]));

      expect((error as CliError).code).toBe(code);
    }
  });
});

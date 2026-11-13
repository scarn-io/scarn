import { describe, expect, test } from "bun:test";
import { formatTaskRunView } from "../src/format-task-run";
import { formatTaskList, formatTaskView } from "../src/format-tasks";
import {
  gatherTaskList,
  gatherTaskRunView,
  gatherTaskView,
  PREVIOUS_TASK_CHAIN_LIMIT,
} from "../src/gather-tasks";
import type { ApiResult } from "../src/lib/api-result";
import type { TaskDetail, TaskRunDetail } from "../src/lib/task-api-types";
import type { TaskReadClient } from "../src/lib/task-read-client";
import {
  makeArtifact,
  makeTaskDetail,
  makeTaskRun,
  makeTaskSummary,
  PREVIOUS_TASK_ID,
  PROJECT_ID,
  TASK_ID,
  TASK_RUN_ID,
} from "./task-fixtures";

const headers = { Authorization: "Bearer test" };

const ok = <T>(data: T): Promise<ApiResult<T>> =>
  Promise.resolve({ data, error: undefined });
const fail = <T>(status: number, detail: string): Promise<ApiResult<T>> =>
  Promise.resolve({ data: undefined, error: { status, detail } });

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`rejected with a non-Error: ${String(error)}`);
  }
  throw new Error("expected the promise to reject");
}

function fakeClient(options: {
  tasks?: Record<string, TaskDetail>;
  runs?: TaskRunDetail[] | "down";
  calls?: { listQuery?: unknown };
}): TaskReadClient {
  const tasks = options.tasks ?? {};
  return {
    tasks: {
      listProjectTasks: ({ query }) => {
        if (options.calls !== undefined) options.calls.listQuery = query;
        return ok({
          tasks: [makeTaskSummary()],
          nextCursor: "next",
          counts: { failed: 1 },
        });
      },
      getTask: ({ path }) => {
        const task = tasks[path.taskId];
        return task === undefined ? fail(404, "Not found") : ok(task);
      },
      getTaskRuns: () =>
        options.runs === "down"
          ? fail(500, "runs are down")
          : ok(options.runs ?? []),
    },
    taskRuns: {
      getTaskRun: ({ path }) =>
        path.taskRunId === TASK_RUN_ID
          ? ok(makeTaskRun())
          : fail(404, "Not found"),
      listTaskArtifacts: () => ok([makeArtifact()]),
    },
  };
}

describe("tasks list", () => {
  test("passes the filters and renders rows with the view hint", async () => {
    const calls: { listQuery?: unknown } = {};
    const page = await gatherTaskList({
      client: fakeClient({ calls }),
      headers,
      projectId: PROJECT_ID,
      statuses: ["failed", "running"],
      kind: "agent",
      limit: 5,
    });

    expect(calls.listQuery).toEqual({
      status: ["failed", "running"],
      kind: "agent",
      workItemId: undefined,
      limit: 5,
    });
    expect(formatTaskList(page)).toMatchInlineSnapshot(`
      "Tasks (1 shown), newest first
        ✗ 0196a000…00c1  agent  step investigate v3  acme/app#7  Fix login
            0196a000-0000-7000-8000-0000000000c1  failed  run 2  took 1m 35s  created 2026-01-02T00:00:00.000Z
            pipeline run 0196a000-0000-7000-8000-0000000000bb at step investigate
            latest error: Agent crashed …
        … more Tasks; raise --limit or narrow the filters

      → scarn tasks view 0196a000-0000-7000-8000-0000000000c1"
    `);
  });

  test("says so when nothing matches", () => {
    expect(formatTaskList({ tasks: [], nextCursor: null, counts: {} })).toBe(
      "No Tasks match.",
    );
  });
});

describe("tasks view", () => {
  test("renders the Task, its runs and earlier Tasks, with log and run hints", async () => {
    const gathered = await gatherTaskView({
      client: fakeClient({
        tasks: {
          [TASK_ID]: makeTaskDetail({ previousTaskId: PREVIOUS_TASK_ID }),
          [PREVIOUS_TASK_ID]: makeTaskDetail({
            id: PREVIOUS_TASK_ID,
            status: "succeeded",
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
        },
        runs: [
          makeTaskRun({ id: "run-1", number: 1 }),
          makeTaskRun({ number: 2, reason: "continuation" }),
        ],
      }),
      headers,
      taskId: TASK_ID,
    });

    expect(gathered.previousTasks.map((task) => task.id)).toEqual([
      PREVIOUS_TASK_ID,
    ]);
    expect(formatTaskView(gathered)).toMatchInlineSnapshot(`
      "Task 0196a000-0000-7000-8000-0000000000c1  ✗ failed
      Kind:         agent  Investigate
      Source:       step investigate v3
      Work item:    acme/app#7  Fix login  0196a000-0000-7000-8000-0000000000aa
      Step def:     0196a000-0000-7000-8000-0000000000d1
      Pipeline run: 0196a000-0000-7000-8000-0000000000bb at step investigate
      Config:       the repo's own config
      Max turns:    20
      Created:      2026-01-02T00:00:00.000Z
      Updated:      2026-01-02T00:05:00.000Z

      Input:
        {
          "question": "why?"
        }

      Error:
        {
          "name": "AgentError",
          "message": "Agent crashed"
        }

      Runs (2), oldest first:
        #1 ✗ failed  initial  run-1  finished 2026-01-02T00:01:10.000Z
        #2 ✗ failed  continuation  0196a000-0000-7000-8000-0000000000e1  finished 2026-01-02T00:01:10.000Z

      Earlier Tasks of this step, newest first:
        ✓ 0196a000-0000-7000-8000-0000000000c0  succeeded  created 2026-01-01T00:00:00.000Z

      → scarn logs 0196a000-0000-7000-8000-0000000000e1
      → scarn task-runs view 0196a000-0000-7000-8000-0000000000e1
      → scarn runs thread 0196a000-0000-7000-8000-0000000000bb --step investigate"
    `);
  });

  test("a missing Task fails; missing runs and earlier Tasks degrade", async () => {
    const missing = gatherTaskView({
      client: fakeClient({}),
      headers,
      taskId: TASK_ID,
    });
    expect((await rejection(missing)).message).toBe(
      `Task ${TASK_ID} not found.`,
    );

    const gathered = await gatherTaskView({
      client: fakeClient({
        tasks: {
          [TASK_ID]: makeTaskDetail({
            previousTaskId: PREVIOUS_TASK_ID,
            pipelineRunId: null,
            nodeId: null,
          }),
        },
        runs: "down",
      }),
      headers,
      taskId: TASK_ID,
    });
    const text = formatTaskView(gathered);

    expect(text).toContain("Runs: unavailable (runs are down)");
    expect(text).toContain(
      `… could not load Task ${PREVIOUS_TASK_ID}: Not found`,
    );
    expect(text.trimEnd().endsWith("→ scarn tasks list")).toBe(true);
  });

  test("stops following previousTaskId after the chain limit", async () => {
    const tasks: Record<string, TaskDetail> = {};
    for (let index = 0; index <= PREVIOUS_TASK_CHAIN_LIMIT + 1; index += 1) {
      tasks[`task-${String(index)}`] = makeTaskDetail({
        id: `task-${String(index)}`,
        previousTaskId: `task-${String(index + 1)}`,
      });
    }
    const gathered = await gatherTaskView({
      client: fakeClient({ tasks }),
      headers,
      taskId: "task-0",
    });

    expect(gathered.previousTasks).toHaveLength(PREVIOUS_TASK_CHAIN_LIMIT);
    expect(gathered.previousTasksCutOff).toBe(
      `stopped after ${String(PREVIOUS_TASK_CHAIN_LIMIT)} earlier Tasks; next is task-11`,
    );
  });
});

describe("task-runs view", () => {
  test("renders worker, lease, timings, error and artifacts", async () => {
    const gathered = await gatherTaskRunView({
      client: fakeClient({}),
      headers,
      taskRunId: TASK_RUN_ID,
    });

    expect(formatTaskRunView(gathered)).toMatchInlineSnapshot(`
      "Task run 0196a000-0000-7000-8000-0000000000e1  ✗ failed
      Task:         0196a000-0000-7000-8000-0000000000c1  run #1 (initial)
      Kind:         agent  Investigate
      Work item:    0196a000-0000-7000-8000-0000000000aa
      Worker:       worker-laptop-1  claimed 2026-01-02T00:00:01.000Z
      Heartbeat:    2026-01-02T00:01:00.000Z
      Lease until:  2026-01-02T00:01:30.000Z  (every 30s)
      Created:      2026-01-02T00:00:00.000Z
      Started:      2026-01-02T00:00:02.000Z
      Completed:    2026-01-02T00:01:10.000Z
      Base:         main
      Work branch:  scarn/fix-login  from main

      Error:
        {
          "name": "AgentError",
          "message": "Agent crashed"
        }

      Artifacts (1):
        report.md  generic  text/markdown  2.0 KB  0196a000-0000-7000-8000-0000000000f1

      → scarn logs 0196a000-0000-7000-8000-0000000000e1
      → scarn artifacts list 0196a000-0000-7000-8000-0000000000e1
      → scarn tasks view 0196a000-0000-7000-8000-0000000000c1"
    `);
  });

  test("a missing run fails", async () => {
    const missing = gatherTaskRunView({
      client: fakeClient({}),
      headers,
      taskRunId: "nope",
    });

    expect((await rejection(missing)).message).toBe("Task run nope not found.");
  });
});

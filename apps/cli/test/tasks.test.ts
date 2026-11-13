import { describe, expect, setDefaultTimeout, test } from "bun:test";
import yargs from "yargs/yargs";
import type { CommandModule } from "yargs";
import type { TaskReadClient } from "@scarn/shared-core";
import { createTaskRunsCommand } from "../src/commands/task-runs";
import { createTasksCommand } from "../src/commands/tasks";
import type { TaskReadDependencies } from "../src/lib/task-read-dependencies";
import { runCli } from "./utils";

setDefaultTimeout(15_000);

const PROJECT_ID = "0196a000-0000-7000-8000-000000000001";
const WORK_ITEM_ID = "0196a000-0000-7000-8000-0000000000aa";
const TASK_ID = "0196a000-0000-7000-8000-0000000000c1";
const TASK_RUN_ID = "0196a000-0000-7000-8000-0000000000e1";

const ok = <T>(data: T) => Promise.resolve({ data, error: undefined });

const source = {
  kind: "step_definition",
  stepDefinitionId: "0196a000-0000-7000-8000-0000000000d1",
  key: "investigate",
  name: "Investigate",
  version: 1,
} as const;
const workItem = {
  id: WORK_ITEM_ID,
  platformKey: "acme/app#7",
  title: "Fix login",
};

const taskRun = {
  id: TASK_RUN_ID,
  taskId: TASK_ID,
  number: 1,
  reason: "initial",
  workItemId: WORK_ITEM_ID,
  name: null,
  kind: "agent",
  previousTaskRunId: null,
  baseBranch: null,
  baseCommit: null,
  heartbeatSeconds: null,
  status: "running",
  claimedBy: "worker-1",
  claimedAt: "2026-01-02T00:00:01.000Z",
  lastHeartbeatAt: null,
  leaseExpiresAt: "2026-01-02T00:00:31.000Z",
  executionTimeoutSeconds: null,
  executionDeadlineAt: null,
  startedAt: "2026-01-02T00:00:02.000Z",
  completedAt: null,
  resultJson: null,
  errorJson: null,
  workBranch: null,
  createdFromBranch: null,
  sessionRestored: null,
  createdAt: "2026-01-02T00:00:00.000Z",
} as const;

type Calls = { listQuery?: unknown; refs: string[] };

function fakeDependencies(calls: Calls): TaskReadDependencies {
  const client: TaskReadClient = {
    tasks: {
      listProjectTasks: ({ query }) => {
        calls.listQuery = query;
        return ok({
          tasks: [
            {
              id: TASK_ID,
              kind: "agent",
              name: null,
              status: "running",
              createdAt: "2026-01-02T00:00:00.000Z",
              runNumber: 1,
              durationMs: null,
              latest: null,
              workItem,
              source,
              pipelineRunId: null,
              nodeId: null,
            },
          ],
          nextCursor: null,
          counts: { running: 1 },
        });
      },
      getTask: () =>
        ok({
          id: TASK_ID,
          projectId: PROJECT_ID,
          workItemId: WORK_ITEM_ID,
          kind: "agent",
          name: null,
          taskExecutionConfigId: null,
          inputJson: null,
          maxTurns: null,
          status: "running",
          resultJson: null,
          errorJson: null,
          previousTaskId: null,
          createdAt: "2026-01-02T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          workItem,
          source,
          pipelineRunId: null,
          nodeId: null,
          startedBy: null,
          waitingOn: [],
          conversationId: null,
        }),
      getTaskRuns: () => ok([taskRun]),
    },
    taskRuns: {
      getTaskRun: () => ok(taskRun),
      listTaskArtifacts: () => ok([]),
    },
  };
  const headers = { Authorization: "Bearer test" };
  return {
    connect: () => Promise.resolve({ client, headers }),
    connectProject: () =>
      Promise.resolve({ client, headers, projectId: PROJECT_ID }),
    resolveRef: (ref) => {
      calls.refs.push(ref);
      return Promise.resolve({
        workItemId: WORK_ITEM_ID,
        projectId: PROJECT_ID,
      });
    },
  };
}

async function runCommand(
  build: (deps: TaskReadDependencies) => CommandModule<object, object>,
  args: readonly string[],
): Promise<{ stdout: string; calls: Calls }> {
  const calls: Calls = { refs: [] };
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    await yargs([...args])
      .command(build(fakeDependencies(calls)))
      .strict()
      .exitProcess(false)
      .showHelpOnFail(false)
      .fail((message, error) => {
        throw error instanceof Error ? error : new Error(message);
      })
      .parseAsync();
  } finally {
    process.stdout.write = originalWrite;
  }
  return { stdout: chunks.join(""), calls };
}

const runTasks = (args: readonly string[]) =>
  runCommand(createTasksCommand, ["tasks", ...args]);
const runTaskRuns = (args: readonly string[]) =>
  runCommand(createTaskRunsCommand, ["task-runs", ...args]);

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`rejected with a non-Error: ${String(error)}`);
  }
  throw new Error("expected the promise to reject");
}

describe("scarn tasks", () => {
  test("--help lists every verb", async () => {
    const result = await runCli(["tasks", "--help"]);

    expect(result.exitCode).toBe(0);
    for (const verb of ["list", "view <taskId>"]) {
      expect(result.stdout).toContain(verb);
    }
  });

  test("list resolves the work item, passes repeated --status and ends with the view hint", async () => {
    const { stdout, calls } = await runTasks([
      "list",
      "--work-item",
      "acme/app#7",
      "--status",
      "failed",
      "--status",
      "running",
      "--kind",
      "agent",
      "--limit",
      "5",
    ]);

    expect(calls.refs).toEqual(["acme/app#7"]);
    expect(calls.listQuery).toEqual({
      status: ["failed", "running"],
      kind: "agent",
      workItemId: WORK_ITEM_ID,
      limit: 5,
    });
    expect(stdout.trimEnd().endsWith(`→ scarn tasks view ${TASK_ID}`)).toBe(
      true,
    );
  });

  test("list --json prints only the API page", async () => {
    const { stdout } = await runTasks(["list", "--json"]);
    const body = JSON.parse(stdout) as { tasks: { id: string }[] };

    expect(body.tasks[0]?.id).toBe(TASK_ID);
  });

  test("list rejects an unknown --status or --kind", async () => {
    expect(
      (await rejection(runTasks(["list", "--status", "done"]))).message,
    ).toContain('Invalid --status "done"');
    expect(
      (await rejection(runTasks(["list", "--kind", "human"]))).message,
    ).toBe('Invalid --kind "human". Expected one of: agent, code.');
  });

  test("view ends with the latest run's logs and detail", async () => {
    const { stdout } = await runTasks(["view", TASK_ID]);

    expect(stdout).toContain(`Task ${TASK_ID}  ● running`);
    expect(stdout.trimEnd().split("\n").slice(-2)).toEqual([
      `→ scarn logs ${TASK_RUN_ID}`,
      `→ scarn task-runs view ${TASK_RUN_ID}`,
    ]);
  });

  test("view --json prints the Task, its runs and earlier Tasks", async () => {
    const { stdout } = await runTasks(["view", TASK_ID, "--json"]);
    const body = JSON.parse(stdout) as {
      task: { id: string };
      runs: { status: string };
      previousTasks: unknown[];
    };

    expect(body.task.id).toBe(TASK_ID);
    expect(body.runs.status).toBe("loaded");
    expect(body.previousTasks).toEqual([]);
  });
});

describe("scarn task-runs", () => {
  test("view shows the worker lease and ends with logs and artifacts hints", async () => {
    const { stdout } = await runTaskRuns(["view", TASK_RUN_ID]);

    expect(stdout).toContain("Worker:       worker-1");
    expect(stdout).toContain("Lease until:  2026-01-02T00:00:31.000Z");
    expect(stdout).toContain(`→ scarn logs ${TASK_RUN_ID}`);
    expect(stdout).toContain(`→ scarn artifacts list ${TASK_RUN_ID}`);
  });

  test("view --json prints the run and its artifacts", async () => {
    const { stdout } = await runTaskRuns(["view", TASK_RUN_ID, "--json"]);
    const body = JSON.parse(stdout) as {
      run: { id: string };
      artifacts: { status: string; data: unknown[] };
    };

    expect(body.run.id).toBe(TASK_RUN_ID);
    expect(body.artifacts).toEqual({ status: "loaded", data: [] });
  });
});

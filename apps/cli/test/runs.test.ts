import { describe, expect, setDefaultTimeout, test } from "bun:test";
import yargs from "yargs/yargs";
import type { RunReadClient } from "@scarn/shared-core";
import {
  createRunsCommand,
  type RunReadDependencies,
} from "../src/commands/runs";
import { runCli } from "./utils";

setDefaultTimeout(15_000);

const PROJECT_ID = "0196a000-0000-7000-8000-000000000001";
const WORK_ITEM_ID = "0196a000-0000-7000-8000-0000000000aa";
const RUN_ID = "0196a000-0000-7000-8000-0000000000bb";
const PIPELINE_ID = "0196a000-0000-7000-8000-0000000000d1";

const ok = <T>(data: T) => Promise.resolve({ data, error: undefined });

type Calls = { listQuery?: unknown; threadPath?: unknown; refs: string[] };

function fakeDependencies(calls: Calls): RunReadDependencies {
  const client: RunReadClient = {
    pipelineExecutions: {
      listPipelineExecutions: ({ query }) => {
        calls.listQuery = query;
        return ok({
          items: [
            {
              id: RUN_ID,
              workItemId: WORK_ITEM_ID,
              workItemTitle: "Fix login",
              pipelineDefinitionId: PIPELINE_ID,
              status: "waiting",
              waitingFor: "reply",
              error: null,
              startedAt: "2026-01-02T00:00:00.000Z",
              completedAt: null,
              createdAt: "2026-01-02T00:00:00.000Z",
              openNodeIds: ["build"],
            },
          ],
          pagination: { page: 1, pageSize: 25, total: 1 },
        });
      },
      getPipelineExecution: () =>
        ok({
          id: RUN_ID,
          workItemId: WORK_ITEM_ID,
          workItemTitle: "Fix login",
          pipelineDefinitionId: PIPELINE_ID,
          status: "waiting",
          visits: [
            {
              id: "visit-1",
              nodeId: "build",
              nodeKind: "step",
              status: "waiting",
              tasks: [],
              createdAt: "2026-01-02T00:00:00.000Z",
              completedAt: null,
            },
          ],
        }),
      getVisitThread: ({ path }) => {
        calls.threadPath = path;
        return ok({ visitId: "visit-1", nodeId: "build", runs: [] });
      },
    },
    pipelineDefinitions: {
      listPipelineDefinitions: () =>
        ok([
          {
            id: PIPELINE_ID,
            key: "ship-it",
            name: "Ship it",
            archivedAt: null,
          },
        ]),
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

async function runRuns(
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
    await yargs(["runs", ...args])
      .command(createRunsCommand(fakeDependencies(calls)))
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

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`rejected with a non-Error: ${String(error)}`);
  }
  throw new Error("expected the promise to reject");
}

describe("scarn runs list / thread", () => {
  test("--help lists every verb", async () => {
    const result = await runCli(["runs", "--help"]);

    expect(result.exitCode).toBe(0);
    for (const verb of ["list", "thread <runId>"]) {
      expect(result.stdout).toContain(verb);
    }
    expect(result.stdout).not.toContain("view");
  });

  test("list resolves the work item and pipeline and ends with the thread hint", async () => {
    const { stdout, calls } = await runRuns([
      "list",
      "--work-item",
      "acme/app#7",
      "--pipeline",
      "ship-it",
      "--status",
      "waiting",
      "--limit",
      "5",
    ]);

    expect(calls.refs).toEqual(["acme/app#7"]);
    expect(calls.listQuery).toEqual({
      projectId: PROJECT_ID,
      pipelineId: PIPELINE_ID,
      workItemId: WORK_ITEM_ID,
      status: "waiting",
      sort: "newest",
      page: 1,
      pageSize: 5,
    });
    expect(stdout).toContain("ship-it  Fix login");
    expect(stdout).toContain("waiting for reply  at build");
    expect(
      stdout.trimEnd().endsWith(`→ scarn runs thread ${RUN_ID} --step build`),
    ).toBe(true);
  });

  test("list --json prints only the API page", async () => {
    const { stdout } = await runRuns(["list", "--json"]);
    const body = JSON.parse(stdout) as { items: { id: string }[] };

    expect(body.items[0]?.id).toBe(RUN_ID);
  });

  test("list rejects an unknown --status", async () => {
    expect(
      (await rejection(runRuns(["list", "--status", "done"]))).message,
    ).toBe(
      'Invalid --status "done". Expected one of: queued, running, waiting, succeeded, failed, cancelled.',
    );
  });

  test("thread maps --step to the visit and prints its thread", async () => {
    const { stdout, calls } = await runRuns([
      "thread",
      RUN_ID,
      "--step",
      "build",
    ]);

    expect(calls.threadPath).toEqual({
      pipelineExecutionId: RUN_ID,
      visitId: "visit-1",
    });
    expect(stdout).toContain('Thread of step "build"');
    expect(stdout).toContain("No Task runs yet.");
  });

  test("thread --json prints only the thread body", async () => {
    const { stdout } = await runRuns([
      "thread",
      RUN_ID,
      "--step",
      "build",
      "--json",
    ]);

    expect(JSON.parse(stdout)).toEqual({
      visitId: "visit-1",
      nodeId: "build",
      runs: [],
    });
  });

  test("the old execution noun is gone", async () => {
    const result = await runCli(["execution", "list"]);

    expect(result.exitCode).not.toBe(0);
  });

  test("thread requires --step", async () => {
    expect((await rejection(runRuns(["thread", RUN_ID]))).message).toContain(
      "step",
    );
  });
});

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import yargs from "yargs/yargs";
import type { WorkItemDetail, WorkItemReadClient } from "@scarn/shared-core";
import {
  createWorkItemsCommand,
  type WorkItemsDependencies,
} from "../src/commands/work-items";
import { CliError } from "../src/lib/cli-error";
import { runCli } from "./utils";

setDefaultTimeout(15_000);

const WORK_ITEM_ID = "0196a000-0000-7000-8000-0000000000aa";
const PROJECT_ID = "0196a000-0000-7000-8000-000000000001";
const RUN_ID = "0196a000-0000-7000-8000-0000000000bb";

const ok = <T>(data: T) => Promise.resolve({ data, error: undefined });
const fail = (detail: string) =>
  Promise.resolve({ data: undefined, error: { status: 500, detail } });

const workItem: WorkItemDetail = {
  id: WORK_ITEM_ID,
  projectId: PROJECT_ID,
  platform: "github",
  platformKey: "acme/app#7",
  url: "https://github.com/acme/app/issues/7",
  title: "Fix the flaky login test",
  description: "Fails on CI.",
  fields: null,
  labels: ["bug"],
  createdByUsername: "ada",
  assigneeUserId: null,
  parentWorkItemId: null,
  state: "open",
  closeReason: null,
  resolution: null,
  closedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

const comment = (index: number) => ({
  id: `comment-${String(index)}`,
  authorKind: "user" as const,
  authorName: null,
  authorUsername: "ada",
  authoredByTaskId: null,
  parentCommentId: null,
  externalCommentUrl: null,
  body: `Comment ${String(index)}`,
  isPinned: false,
  createdAt: "2026-01-02T00:00:00.000Z",
});

type Calls = { listQuery?: unknown; resolvedRefs: string[] };

function fakeDependencies(calls: Calls): WorkItemsDependencies {
  const client: WorkItemReadClient = {
    projects: {
      listProjectWorkItems: ({ query }) => {
        calls.listQuery = query;
        return ok({
          items: [
            { ...workItem, latestExecutionStatus: "failed", assignee: null },
          ],
          pagination: { page: 1, pageSize: 1, total: 1 },
        });
      },
    },
    tasks: {
      listProjectTasks: () => fail("tasks are down"),
    },
    workItems: {
      getWorkItem: () => ok(workItem),
      listWorkItemChildren: () => ok([]),
      listWorkItemQuestions: () => ok([]),
      listWorkItemActivity: () =>
        ok([
          {
            id: "activity-1",
            kind: "automation",
            message: "Attached wayfinder.",
            createdAt: "2026-01-02T00:00:00.000Z",
          },
        ]),
    },
    workItemBlocks: {
      listWorkItemBlocks: () => ok({ blockedBy: [], blocking: [] }),
    },
    workItemComments: {
      listWorkItemComments: () => ok([1, 2, 3].map(comment)),
    },
    workItemCommentDrafts: { listPendingCommentDrafts: () => ok([]) },
    pipelineExecutions: {
      listPipelineExecutions: () =>
        ok({
          items: [
            {
              id: RUN_ID,
              pipelineDefinitionId: "pipeline-def-1",
              status: "failed",
              waitingFor: null,
              startedAt: "2026-01-02T00:00:00.000Z",
              completedAt: "2026-01-02T00:10:00.000Z",
              createdAt: "2026-01-02T00:00:00.000Z",
            },
          ],
          pagination: { page: 1, pageSize: 5, total: 1 },
        }),
    },
  };
  const headers = { Authorization: "Bearer test" };
  return {
    connect: () => Promise.resolve({ client, headers }),
    connectProject: () =>
      Promise.resolve({ client, headers, projectId: PROJECT_ID }),
    resolveRef: (ref) => {
      calls.resolvedRefs.push(ref);
      if (ref === "acme/app#404") {
        return Promise.reject(
          new CliError("no_work_item", "No work item with key acme/app#404."),
        );
      }
      return Promise.resolve({
        workItemId: WORK_ITEM_ID,
        projectId: PROJECT_ID,
      });
    },
  };
}

async function runWorkItems(
  args: readonly string[],
): Promise<{ stdout: string; calls: Calls }> {
  const calls: Calls = { resolvedRefs: [] };
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    await yargs(["work-items", ...args])
      .command(createWorkItemsCommand(fakeDependencies(calls)))
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

/** The error `promise` rejects with; fails the test if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`rejected with a non-Error: ${String(error)}`);
  }
  throw new Error("expected the promise to reject");
}

describe("scarn work-items", () => {
  test("--help lists every read verb", async () => {
    const result = await runCli(["work-items", "--help"]);

    expect(result.exitCode).toBe(0);
    for (const verb of [
      "list",
      "view <ref>",
      "comments <ref>",
      "activity <ref>",
    ]) {
      expect(result.stdout).toContain(verb);
    }
  });

  test("list passes the filters through and ends with the view hint", async () => {
    const { stdout, calls } = await runWorkItems([
      "list",
      "--status",
      "failed",
      "--label",
      "bug",
      "--label",
      "flaky",
      "--platform",
      "github",
      "--assignee",
      "me",
      "--updated-after",
      "7d",
      "--search",
      "login",
      "--limit",
      "10",
    ]);

    expect(calls.listQuery).toEqual({
      page: 1,
      pageSize: 10,
      sort: "updated-desc",
      q: "login",
      status: "failed",
      labels: ["bug", "flaky"],
      platform: "github",
      assignee: "me",
      updatedAfter: "7d",
    });
    expect(stdout).toContain("acme/app#7  Fix the flaky login test");
    expect(
      stdout.trimEnd().endsWith(`→ scarn work-items view ${WORK_ITEM_ID}`),
    ).toBe(true);
  });

  test("list --json prints only the API body", async () => {
    const { stdout } = await runWorkItems(["list", "--json"]);
    const body = JSON.parse(stdout) as { items: { id: string }[] };

    expect(body.items[0]?.id).toBe(WORK_ITEM_ID);
  });

  test("list rejects a --limit above the page size cap", async () => {
    expect(
      (await rejection(runWorkItems(["list", "--limit", "500"]))).message,
    ).toBe("--limit can be at most 100.");
  });

  test("view resolves the ref and renders a failed sub-read inline", async () => {
    const { stdout, calls } = await runWorkItems(["view", "acme/app#7"]);

    expect(calls.resolvedRefs).toEqual(["acme/app#7"]);
    expect(stdout).toContain(`Work item ${WORK_ITEM_ID}`);
    expect(stdout).toContain("Latest Tasks: (unavailable: tasks are down)");
    expect(stdout).toContain(`→ scarn runs list --work-item ${WORK_ITEM_ID}`);
  });

  test("view --json prints the gathered sections as one document", async () => {
    const { stdout } = await runWorkItems(["view", WORK_ITEM_ID, "--json"]);
    const body = JSON.parse(stdout) as {
      workItem: { id: string };
      tasks: { status: string };
    };

    expect(body.workItem.id).toBe(WORK_ITEM_ID);
    expect(body.tasks.status).toBe("unavailable");
  });

  test("view surfaces an unresolvable ref", async () => {
    expect(
      (await rejection(runWorkItems(["view", "acme/app#404"]))).message,
    ).toBe("No work item with key acme/app#404.");
  });

  test("comments keeps the latest --limit entries", async () => {
    const { stdout } = await runWorkItems([
      "comments",
      WORK_ITEM_ID,
      "--limit",
      "2",
    ]);

    expect(stdout).toContain("(2 of 3)");
    expect(stdout).not.toContain("Comment 1");
    expect(stdout).toContain("Comment 3");
  });

  test("comments --drafts --json prints the drafts array", async () => {
    const { stdout } = await runWorkItems([
      "comments",
      WORK_ITEM_ID,
      "--drafts",
      "--json",
    ]);

    expect(JSON.parse(stdout)).toEqual([]);
  });

  test("activity renders entries and the comments hint", async () => {
    const { stdout } = await runWorkItems(["activity", WORK_ITEM_ID]);

    expect(stdout).toContain("automation  Attached wayfinder.");
    expect(stdout).toContain(`→ scarn work-items comments ${WORK_ITEM_ID}`);
  });
});

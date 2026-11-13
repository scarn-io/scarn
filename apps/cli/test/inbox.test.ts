import { describe, expect, setDefaultTimeout, test } from "bun:test";
import yargs from "yargs/yargs";
import type { GatheredInbox, InboxReadClient } from "@scarn/shared-core";
import {
  createInboxCommand,
  type InboxDependencies,
} from "../src/commands/inbox";
import { runCli } from "./utils";

setDefaultTimeout(15_000);

const PROJECT_ID = "0196a000-0000-7000-8000-000000000001";
const WORK_ITEM_ID = "0196a000-0000-7000-8000-0000000000aa";
const RUN_ID = "0196a000-0000-7000-8000-0000000000bb";

const ok = <T>(data: T) => Promise.resolve({ data, error: undefined });

const workItem = {
  id: WORK_ITEM_ID,
  platformKey: "acme/app#7",
  title: "Fix login",
};

function fakeDependencies(taskLimits: unknown[]): InboxDependencies {
  const client: InboxReadClient = {
    inbox: {
      getProjectInboxSummary: () =>
        ok({
          waitingOnMe: 0,
          failedStartedByMe: 0,
          pipelineWaitsOnMe: 1,
          workItemsWaitingOnMe: 0,
          badgeCount: 1,
          waitingOnOthers: 0,
        }),
      listProjectInboxWaits: () =>
        ok({
          waits: [
            {
              kind: "decision",
              pipelineExecutionId: RUN_ID,
              visitId: "visit-1",
              nodeId: "approve",
              pipelineName: "Ship it",
              workItem,
              askedAt: "2026-01-02T00:00:00.000Z",
              title: null,
              actions: [{ key: "ship", label: "Ship", body: "optional" }],
            },
          ],
          workItems: [],
        }),
    },
    tasks: {
      listProjectTasks: ({ query }) => {
        taskLimits.push(query.limit);
        return ok({ tasks: [], nextCursor: null, counts: {} });
      },
    },
    projects: {
      listProjectWorkItems: () =>
        ok({
          items: [{ ...workItem, awaitingApprovalCount: 1 }],
          pagination: { total: 1 },
        }),
    },
    userNotifications: {
      listUserNotifications: () => ok([]),
    },
  };
  return {
    connectProject: () =>
      Promise.resolve({
        client,
        headers: { Authorization: "Bearer test" },
        projectId: PROJECT_ID,
      }),
  };
}

async function runInbox(
  args: readonly string[],
): Promise<{ stdout: string; taskLimits: unknown[] }> {
  const taskLimits: unknown[] = [];
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    await yargs(["inbox", ...args])
      .command(createInboxCommand(fakeDependencies(taskLimits)))
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
  return { stdout: chunks.join(""), taskLimits };
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

describe("scarn inbox", () => {
  test("--help describes the command", async () => {
    const result = await runCli(["inbox", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--project");
  });

  test("prints the counts, then each entry with its next command", async () => {
    const { stdout, taskLimits } = await runInbox(["--limit", "5"]);

    expect(taskLimits).toEqual([5, 5]);
    expect(stdout).toContain("Inbox: 1 waiting on you");
    expect(stdout).toContain(`→ scarn runs list --work-item ${WORK_ITEM_ID}`);
    expect(stdout).toContain(
      `→ scarn work-items comments ${WORK_ITEM_ID} --drafts`,
    );
  });

  test("--json prints only the gathered inbox", async () => {
    const { stdout } = await runInbox(["--json"]);
    const body = JSON.parse(stdout) as GatheredInbox;

    expect(body.summary.badgeCount).toBe(1);
    expect(body.drafts).toEqual({
      status: "loaded",
      data: {
        items: [{ ...workItem, awaitingApprovalCount: 1 }],
        pagination: { total: 1 },
      },
    });
  });

  test("rejects an out-of-range --limit", async () => {
    expect((await rejection(runInbox(["--limit", "0"]))).message).toBe(
      "--limit must be a whole number from 1 to 100, got 0.",
    );
  });
});

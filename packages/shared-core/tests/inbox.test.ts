import { describe, expect, test } from "bun:test";
import { formatInbox } from "../src/format-inbox";
import { gatherInbox } from "../src/gather-inbox";
import type { InboxReadClient } from "../src/lib/inbox-read-client";
import {
  PIPELINE_RUN_ID,
  PROJECT_ID,
  WORK_ITEM_ID,
  makeTaskSummary,
} from "./task-fixtures";

const QUESTION_ID = "0196a000-0000-7000-8000-0000000000f1";
const headers = { Authorization: "Bearer test" };
const ok = <T>(data: T) => Promise.resolve({ data, error: undefined });

const workItem = {
  id: WORK_ITEM_ID,
  platformKey: "acme/app#7",
  title: "Fix login",
};

type Calls = { taskQueries: unknown[]; workItemQuery?: unknown };

function fakeClient(calls: Calls): InboxReadClient {
  return {
    inbox: {
      getProjectInboxSummary: () =>
        ok({
          waitingOnMe: 1,
          failedStartedByMe: 0,
          pipelineWaitsOnMe: 2,
          workItemsWaitingOnMe: 0,
          badgeCount: 3,
          waitingOnOthers: 4,
        }),
      listProjectInboxWaits: () =>
        ok({
          waits: [
            {
              kind: "reply",
              pipelineExecutionId: PIPELINE_RUN_ID,
              visitId: "visit-1",
              nodeId: "build",
              pipelineName: "Ship it",
              workItem,
              askedAt: "2026-01-02T00:01:00.000Z",
              questionId: QUESTION_ID,
              commentId: "comment-1",
              body: "Which branch should I use?\nmain or dev",
            },
            {
              kind: "decision",
              pipelineExecutionId: PIPELINE_RUN_ID,
              visitId: "visit-2",
              nodeId: "approve",
              pipelineName: "Ship it",
              workItem,
              askedAt: "2026-01-02T00:02:00.000Z",
              title: "Ship?",
              actions: [
                { key: "ship", label: "Ship", body: "optional" },
                { key: "stop", label: "Stop", body: "required" },
              ],
            },
          ],
          workItems: [],
        }),
    },
    tasks: {
      listProjectTasks: ({ query }) => {
        calls.taskQueries.push(query);
        return ok({
          tasks:
            query.waitingOnMe === true
              ? [
                  makeTaskSummary({
                    status: "waiting_for_person",
                    latest: { kind: "message", text: "Need a token" },
                    pipelineRunId: null,
                    nodeId: null,
                  }),
                ]
              : [],
          nextCursor: null,
          counts: {},
        });
      },
    },
    projects: {
      listProjectWorkItems: ({ query }) => {
        calls.workItemQuery = query;
        return ok({
          items: [{ ...workItem, awaitingApprovalCount: 2 }],
          pagination: { total: 1 },
        });
      },
    },
    userNotifications: {
      listUserNotifications: () =>
        Promise.resolve({
          data: undefined,
          error: { status: 500, title: "Server error" },
        }),
    },
  };
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the promise to reject");
}

describe("inbox", () => {
  test("lists waits, Tasks and drafts, each with its next command", async () => {
    const calls: Calls = { taskQueries: [] };
    const gathered = await gatherInbox({
      client: fakeClient(calls),
      headers,
      projectId: PROJECT_ID,
      limit: 20,
    });

    expect(calls.taskQueries).toEqual([
      { waitingOnMe: true, excludeEndedChats: true, limit: 20 },
      {
        status: ["failed"],
        startedByMe: true,
        excludeEndedChats: true,
        limit: 20,
      },
    ]);
    expect(calls.workItemQuery).toEqual({
      awaitingApproval: "true",
      pageSize: 20,
    });
    expect(formatInbox(gathered)).toMatchInlineSnapshot(`
      "Inbox: 3 waiting on you
        Tasks waiting on you      1
        Pipeline waits on you     2
        Failed Tasks you started  0
        Work items to start       0
        Tasks waiting on others   4

      Pipeline waits (2)
        ‼ question  acme/app#7  Fix login
            Ship it / build  run 0196a000-0000-7000-8000-0000000000bb  asked 2026-01-02T00:01:00.000Z
            Which branch should I use?
            → scarn work-items view 0196a000-0000-7000-8000-0000000000aa
            → scarn work-items answer 0196a000-0000-7000-8000-0000000000aa 0196a000-0000-7000-8000-0000000000f1 --body <text>
        ‼ decision  acme/app#7  Fix login  "Ship?"
            Ship it / approve  run 0196a000-0000-7000-8000-0000000000bb  asked 2026-01-02T00:02:00.000Z
            actions: ship, stop
            → scarn runs list --work-item 0196a000-0000-7000-8000-0000000000aa

      Tasks waiting on you (1)
        ‼ 0196a000…00c1  Investigate  acme/app#7 Fix login
            0196a000-0000-7000-8000-0000000000c1  waiting_for_person  created 2026-01-02T00:00:00.000Z
            message: Need a token
            → scarn tasks view 0196a000-0000-7000-8000-0000000000c1

      Comment drafts to approve (1)
        ○ acme/app#7  Fix login  2 draft(s)
            → scarn work-items comments 0196a000-0000-7000-8000-0000000000aa --drafts

      Latest notifications: (unavailable: Server error)

      → scarn runs list --status waiting
      → scarn tasks list"
    `);
  });

  test("an empty inbox says so", async () => {
    const calls: Calls = { taskQueries: [] };
    const client = fakeClient(calls);
    client.inbox.listProjectInboxWaits = () => ok({ waits: [], workItems: [] });
    client.tasks.listProjectTasks = () =>
      ok({ tasks: [], nextCursor: null, counts: {} });
    client.projects.listProjectWorkItems = () =>
      ok({ items: [], pagination: { total: 0 } });
    client.userNotifications.listUserNotifications = () => ok([]);
    const gathered = await gatherInbox({
      client,
      headers,
      projectId: PROJECT_ID,
      limit: 20,
    });

    expect(formatInbox(gathered)).toContain("Nothing is waiting on you.");
  });

  test("the summary must load", async () => {
    const calls: Calls = { taskQueries: [] };
    const client = fakeClient(calls);
    client.inbox.getProjectInboxSummary = () =>
      Promise.resolve({
        data: undefined,
        error: { status: 403, detail: "Members only." },
      });

    expect(
      await rejectionMessage(
        gatherInbox({ client, headers, projectId: PROJECT_ID, limit: 20 }),
      ),
    ).toBe("Could not load the inbox: Members only.");
  });
});

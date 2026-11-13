import { describe, expect, test } from "bun:test";
import { gatherWorkItem } from "../src/gather-work-item";
import type { WorkItemReadClient } from "../src/lib/work-item-read-client";
import {
  makeRunListItem,
  makeWorkItemDetail,
  PROJECT_ID,
  WORK_ITEM_ID,
} from "./work-item-fixtures";

const headers = { Authorization: "Bearer test" };
const ok = <T>(data: T) => Promise.resolve({ data, error: undefined });
const fail = (detail: string) =>
  Promise.resolve({ data: undefined, error: { status: 403, detail } });

function fakeClient(
  overrides: Partial<WorkItemReadClient["workItems"]> = {},
): WorkItemReadClient {
  return {
    projects: {
      listProjectWorkItems: () => fail("unused"),
    },
    tasks: {
      listProjectTasks: () => Promise.reject(new Error("fetch failed")),
    },
    workItems: {
      getWorkItem: () => ok(makeWorkItemDetail()),
      listWorkItemChildren: () => fail("Forbidden"),
      listWorkItemQuestions: () => ok([]),
      listWorkItemActivity: () => ok([]),
      ...overrides,
    },
    workItemBlocks: {
      listWorkItemBlocks: () => ok({ blockedBy: [], blocking: [] }),
    },
    workItemComments: { listWorkItemComments: () => ok([]) },
    workItemCommentDrafts: { listPendingCommentDrafts: () => ok([]) },
    pipelineExecutions: {
      listPipelineExecutions: ({ query }) => {
        expect(query).toEqual({
          projectId: PROJECT_ID,
          workItemId: WORK_ITEM_ID,
          sort: "newest",
          pageSize: 5,
        });
        return ok({
          items: [makeRunListItem()],
          pagination: { page: 1, pageSize: 5, total: 1 },
        });
      },
    },
  };
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

describe("gatherWorkItem", () => {
  test("turns failed and rejected sub-reads into unavailable sections", async () => {
    const gathered = await gatherWorkItem({
      client: fakeClient(),
      headers,
      workItemId: WORK_ITEM_ID,
      projectId: PROJECT_ID,
    });

    expect(gathered.workItem.id).toBe(WORK_ITEM_ID);
    expect(gathered.children).toEqual({
      status: "unavailable",
      reason: "Forbidden",
    });
    expect(gathered.tasks).toEqual({
      status: "unavailable",
      reason: "fetch failed",
    });
    expect(gathered.questions).toEqual({ status: "loaded", data: [] });
    expect(gathered.runs.status).toBe("loaded");
  });

  test("fails when the work item itself cannot be read", async () => {
    const gathering = gatherWorkItem({
      client: fakeClient({ getWorkItem: () => fail("Not found") }),
      headers,
      workItemId: WORK_ITEM_ID,
      projectId: PROJECT_ID,
    });

    expect((await rejection(gathering)).message).toBe(
      `Could not load work item ${WORK_ITEM_ID}: Not found`,
    );
  });
});

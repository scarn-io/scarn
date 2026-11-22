import { describe, expect, test } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import {
  isProjectRunInProgress,
  listProjectRunsQuerySchema,
  PROJECT_RUN_STATUS_TABS,
  projectRunStatusesOf,
  projectRunStatusValues,
} from "@/pipeline-executions/project-runs/contracts/project-runs-contracts";
import {
  deriveProjectRunStatus,
  pipelineRunWaitingOn,
} from "@/pipeline-executions/project-runs/application/project-run-status";

const pipeline = (
  overrides: Partial<{
    status:
      "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
    waitingFor: "decision" | "reply" | null;
    endNodeId: string | null;
    waitingOnYou: boolean;
  }>,
) =>
  deriveProjectRunStatus({
    type: "pipeline",
    status: "running",
    waitingFor: null,
    endNodeId: null,
    waitingOnYou: false,
    ...overrides,
  });

describe("deriveProjectRunStatus for a pipeline run", () => {
  test("a decision wait on the viewer needs them", () => {
    expect(
      pipeline({
        status: "waiting",
        waitingFor: "decision",
        waitingOnYou: true,
      }),
    ).toBe("needs-you");
  });

  test("a reply wait on the viewer needs them", () => {
    expect(
      pipeline({ status: "waiting", waitingFor: "reply", waitingOnYou: true }),
    ).toBe("needs-you");
  });

  test("a wait on someone else is waiting", () => {
    expect(
      pipeline({
        status: "waiting",
        waitingFor: "decision",
        waitingOnYou: false,
      }),
    ).toBe("waiting");
  });

  test("a wait on an event or timer is waiting, whoever views it", () => {
    expect(
      pipeline({ status: "waiting", waitingFor: null, waitingOnYou: true }),
    ).toBe("waiting");
  });

  test("running and queued pass through", () => {
    expect(pipeline({ status: "running" })).toBe("running");
    expect(pipeline({ status: "queued" })).toBe("queued");
  });

  test("succeeded is done", () => {
    expect(pipeline({ status: "succeeded", endNodeId: "done" })).toBe("done");
  });

  test("failed at a fail end has ended", () => {
    expect(pipeline({ status: "failed", endNodeId: "rejected" })).toBe("ended");
  });

  test("failed without an end node has failed", () => {
    expect(pipeline({ status: "failed", endNodeId: null })).toBe("failed");
  });

  test("cancelled is cancelled", () => {
    expect(pipeline({ status: "cancelled" })).toBe("cancelled");
  });
});

describe("deriveProjectRunStatus for a Task", () => {
  test.each([
    ["waiting_for_person", true, "needs-you"],
    ["waiting_for_person", false, "waiting"],
    ["running", false, "running"],
    ["queued", false, "queued"],
    ["waiting_for_work", false, "queued"],
    ["waiting_for_concurrency_slot", false, "queued"],
    ["succeeded", false, "done"],
    ["failed", false, "failed"],
    ["cancelled", false, "cancelled"],
  ] as const)(
    "%s (waiting on you: %p) is %s",
    (status, waitingOnYou, expected) => {
      expect(
        deriveProjectRunStatus({
          type: "task",
          status,
          waitingOnYou,
          conversationClosed: false,
        }),
      ).toBe(expected);
    },
  );
});

describe("deriveProjectRunStatus for a Task whose conversation closed", () => {
  test.each([
    ["waiting_for_person", true, "done"],
    ["running", false, "done"],
    ["queued", false, "done"],
    ["succeeded", false, "done"],
    ["failed", false, "failed"],
    ["cancelled", false, "cancelled"],
  ] as const)(
    "%s (waiting on you: %p) is %s",
    (status, waitingOnYou, expected) => {
      expect(
        deriveProjectRunStatus({
          type: "task",
          status,
          waitingOnYou,
          conversationClosed: true,
        }),
      ).toBe(expected);
    },
  );
});

describe("pipelineRunWaitingOn", () => {
  const viewer = createUuidV7();
  const other = createUuidV7();

  test("waits on the work item's waiters when waiting on a decision or reply", () => {
    expect(
      pipelineRunWaitingOn({
        waitingFor: "decision",
        waiterUserIds: [other, viewer, other],
        viewerUserId: viewer,
      }),
    ).toEqual({ waitingOnYou: true, waitingOnUserIds: [other, viewer] });
  });

  test("is not on the viewer when they aren't a waiter", () => {
    expect(
      pipelineRunWaitingOn({
        waitingFor: "reply",
        waiterUserIds: [other],
        viewerUserId: viewer,
      }).waitingOnYou,
    ).toBe(false);
  });

  test("is never on a guest", () => {
    expect(
      pipelineRunWaitingOn({
        waitingFor: "reply",
        waiterUserIds: [other],
        viewerUserId: null,
      }),
    ).toEqual({ waitingOnYou: false, waitingOnUserIds: [other] });
  });

  test("waits on nobody unless waiting on a decision or reply", () => {
    expect(
      pipelineRunWaitingOn({
        waitingFor: null,
        waiterUserIds: [viewer],
        viewerUserId: viewer,
      }),
    ).toEqual({ waitingOnYou: false, waitingOnUserIds: [] });
  });
});

describe("status tabs", () => {
  test("In progress and Finished split every status once", () => {
    const open: readonly string[] = PROJECT_RUN_STATUS_TABS.open;
    const finished: readonly string[] = PROJECT_RUN_STATUS_TABS.finished;
    expect([...open, ...finished].sort()).toEqual(
      [...projectRunStatusValues].sort(),
    );
    expect(open.filter((status) => finished.includes(status))).toEqual([]);
  });

  test("isProjectRunInProgress follows the open tab", () => {
    expect(isProjectRunInProgress("waiting")).toBe(true);
    expect(isProjectRunInProgress("ended")).toBe(false);
  });

  test("a status filter selects a tab's statuses or one status", () => {
    expect(projectRunStatusesOf("finished")).toEqual([
      "done",
      "ended",
      "failed",
      "cancelled",
    ]);
    expect(projectRunStatusesOf("needs-you")).toEqual(["needs-you"]);
    expect(projectRunStatusesOf("ended")).toEqual(["ended"]);
  });
});

describe("listProjectRunsQuerySchema", () => {
  test("defaults to every run, 50 at a time", () => {
    expect(listProjectRunsQuerySchema.parse({})).toEqual({
      status: "all",
      limit: 50,
    });
  });

  test("accepts a tab, a status, task and me", () => {
    const parsed = listProjectRunsQuerySchema.parse({
      status: "open",
      whatRan: "task",
      startedBy: "me",
      limit: "100",
    });
    expect(parsed).toMatchObject({
      status: "open",
      whatRan: "task",
      startedBy: "me",
      limit: 100,
    });
    expect(listProjectRunsQuerySchema.parse({ status: "ended" }).status).toBe(
      "ended",
    );
  });

  test("rejects an unknown status and a limit over 100", () => {
    expect(
      listProjectRunsQuerySchema.safeParse({ status: "nope" }).success,
    ).toBe(false);
    expect(listProjectRunsQuerySchema.safeParse({ limit: 101 }).success).toBe(
      false,
    );
    expect(
      listProjectRunsQuerySchema.safeParse({ whatRan: "pipeline" }).success,
    ).toBe(false);
    expect(
      listProjectRunsQuerySchema.safeParse({ whatRan: "chat" }).success,
    ).toBe(false);
  });
});

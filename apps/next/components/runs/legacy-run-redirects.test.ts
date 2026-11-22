import { describe, expect, test } from "bun:test";
import {
  legacyConversationHref,
  legacyConversationsHref,
  legacyExecutionHref,
  legacyExecutionsHref,
  legacyNewConversationHref,
  legacyTaskHref,
  legacyTasksHref,
  mapExecutionStatus,
  mapTaskPreset,
  runPath,
} from "./legacy-run-redirects";

const pipelineId = "019e9a92-b432-73e8-9341-3519156fa900";
const runId = "019e9a92-b432-73e8-9341-3519156fa901";
const taskId = "019e9a92-b432-73e8-9341-3519156fa902";

describe("runPath", () => {
  test("builds each run type's path under the project", () => {
    expect(runPath("alice", "demo", { type: "list" })).toBe("/alice/demo/runs");
    expect(runPath("alice", "demo", { type: "pipeline", id: runId })).toBe(
      `/alice/demo/runs/${runId}`,
    );
    expect(runPath("alice", "demo", { type: "task", id: taskId })).toBe(
      `/alice/demo/runs/tasks/${taskId}`,
    );
  });
});

describe("mapExecutionStatus", () => {
  test.each([
    ["running", "running"],
    ["queued", "queued"],
    ["waiting", "waiting"],
    ["succeeded", "done"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
  ] as const)("%s → %s", (from, to) => {
    expect(mapExecutionStatus(from)).toBe(to);
  });

  test("leaves an unknown or absent status to the Runs default", () => {
    expect(mapExecutionStatus(null)).toBeUndefined();
    expect(mapExecutionStatus("bogus")).toBeUndefined();
    expect(mapExecutionStatus("toString")).toBeUndefined();
  });
});

describe("mapTaskPreset", () => {
  test.each([
    ["needs_attention", "needs-you"],
    ["running", "running"],
    ["queued", "queued"],
    ["waiting_on_blockers", "waiting"],
    ["finished", "finished"],
  ] as const)("%s → %s", (from, to) => {
    expect(mapTaskPreset(from)).toBe(to);
  });

  test("leaves an unknown or absent preset to the Runs default", () => {
    expect(mapTaskPreset(null)).toBeUndefined();
    expect(mapTaskPreset("bogus")).toBeUndefined();
  });
});

describe("executions → runs", () => {
  test("maps pipelineId to whatRan and the status", () => {
    expect(
      legacyExecutionsHref("alice", "demo", {
        pipelineId,
        status: "succeeded",
        sort: "oldest",
        page: "3",
      }),
    ).toBe(`/alice/demo/runs?status=done&whatRan=${pipelineId}`);
  });

  test("drops junk filters and lands on the plain list", () => {
    expect(
      legacyExecutionsHref("alice", "demo", {
        pipelineId: "not-a-uuid",
        status: "bogus",
      }),
    ).toBe("/alice/demo/runs");
    expect(legacyExecutionsHref("alice", "demo", {})).toBe("/alice/demo/runs");
  });
});

describe("executions/[id] → runs/[id]", () => {
  test("keeps the run page's params and drops the rest", () => {
    expect(
      legacyExecutionHref("alice", "demo", runId, {
        step: "review",
        visit: "v1",
        view: "logs",
        filter: "stderr",
        run: "2",
        details: "v1",
        focus: "artifacts",
        from: "inbox",
        page: "4",
      }),
    ).toBe(
      `/alice/demo/runs/${runId}?step=review&visit=v1&view=logs&filter=stderr&run=2&details=v1&focus=artifacts&from=inbox`,
    );
  });

  test("takes the first of a repeated param", () => {
    expect(
      legacyExecutionHref("alice", "demo", runId, { step: ["a", "b"] }),
    ).toBe(`/alice/demo/runs/${runId}?step=a`);
  });

  test("has no query when nothing is kept", () => {
    expect(legacyExecutionHref("alice", "demo", runId, {})).toBe(
      `/alice/demo/runs/${runId}`,
    );
  });
});

describe("tasks → runs", () => {
  test("maps needs_attention to Needs you", () => {
    expect(
      legacyTasksHref("alice", "demo", { preset: "needs_attention" }),
    ).toBe("/alice/demo/runs?status=needs-you");
  });

  test("lands on the default list without a preset", () => {
    expect(legacyTasksHref("alice", "demo", {})).toBe("/alice/demo/runs");
  });
});

describe("tasks/[id]", () => {
  test("goes to the owning pipeline run's step for a step's Task", () => {
    expect(
      legacyTaskHref("alice", "demo", taskId, {
        pipelineRunId: runId,
        nodeId: "review",
      }),
    ).toBe(`/alice/demo/runs/${runId}?step=review`);
  });

  test("goes to the Task's run page for a standalone Task", () => {
    expect(
      legacyTaskHref("alice", "demo", taskId, {
        pipelineRunId: null,
        nodeId: null,
      }),
    ).toBe(`/alice/demo/runs/tasks/${taskId}`);
  });

  test("goes to the Task's run page when the Task couldn't be read", () => {
    expect(legacyTaskHref("alice", "demo", taskId, null)).toBe(
      `/alice/demo/runs/tasks/${taskId}`,
    );
  });
});

describe("conversations", () => {
  test("the list → Tasks in Runs", () => {
    expect(legacyConversationsHref("alice", "demo")).toBe(
      "/alice/demo/runs?whatRan=task",
    );
  });

  test("a chat → its Task's page", () => {
    expect(legacyConversationHref("alice", "demo", { taskId })).toBe(
      `/alice/demo/runs/tasks/${taskId}`,
    );
  });

  test("a chat that couldn't be read, or has no Task → nowhere (404)", () => {
    expect(legacyConversationHref("alice", "demo", null)).toBeNull();
    expect(legacyConversationHref("alice", "demo", {})).toBeNull();
  });

  test("new → Tasks in Runs with the composer open", () => {
    expect(legacyNewConversationHref("alice", "demo")).toBe(
      "/alice/demo/runs?whatRan=task&compose=1",
    );
  });
});

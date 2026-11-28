import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import type { Grant } from "@scarn/core/tasks/task/domain/grants";
import type { GrantRequest } from "@/components/conversations/grant-request-api";
import type { GrantOrigin } from "./task-access-section";

const { api, buildTask, resetApi, withProjectRoute } =
  await import("./tasks-test-support");
const { cleanup, render, waitFor } = await import("@testing-library/react");
const { TaskAccessSection, grantOrigins } =
  await import("./task-access-section");

const alexId = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa7a1");
const readSelf: Grant = { resource: "workItem", action: "read", scope: "self" };
const commentSelf: Grant = {
  resource: "workItem",
  action: "comment",
  scope: "self",
};
const labelSelf = (labels: string[]): Grant => ({
  resource: "workItem",
  action: "label",
  scope: "self",
  labels,
});

const decided = (approved: Grant[]): GrantRequest => ({
  id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa7b1"),
  taskId: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa801"),
  taskRunId: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa811"),
  reason: "To file the bug",
  requested: approved,
  status: "decided",
  approved,
  note: null,
  decidedByUserId: alexId,
  decidedAt: "2026-10-01T12:05:00.000Z",
  createdAt: "2026-10-01T12:00:00.000Z",
});

describe("grantOrigins", () => {
  test("read on its own item is always held, the rest come from the step", () => {
    expect(grantOrigins([readSelf, commentSelf], [])).toEqual([
      [{ kind: "always" }],
      [{ kind: "step" }],
    ]);
  });

  test("an approved grant names its approval; extra step labels keep the step", () => {
    const origins = grantOrigins(
      [commentSelf, labelSelf(["bug", "triage"])],
      [decided([commentSelf, labelSelf(["triage"])])],
    );
    const approval: GrantOrigin = {
      kind: "approved",
      userId: alexId,
      at: "2026-10-01T12:05:00.000Z",
    };
    expect(origins).toEqual([[approval], [{ kind: "step" }, approval]]);
  });

  test("a denied or unanswered request adds nothing", () => {
    const unanswered = { ...decided([]), status: "unanswered" as const };
    expect(grantOrigins([commentSelf], [decided([]), unanswered])).toEqual([
      [{ kind: "step" }],
    ]);
  });
});

describe("TaskAccessSection", () => {
  beforeEach(() => {
    resetApi();
  });

  afterEach(() => {
    cleanup();
  });

  test("lists each grant with where it came from", async () => {
    api.grantRequests = [decided([commentSelf])];
    api.members = [
      {
        userId: alexId,
        username: "alex",
        image: null,
        role: "member",
        permissions: [],
      },
    ];
    const task = {
      ...buildTask(),
      grants: [readSelf, labelSelf(["bug"]), commentSelf],
    };
    const view = render(
      await withProjectRoute(<TaskAccessSection task={task as never} />),
    );

    expect(view.getByRole("region", { name: "Access" })).toBeTruthy();
    await waitFor(() => {
      expect(view.getByText(/^Approved by alex, /)).toBeTruthy();
    });
    const rows = view.getAllByTestId("task-access-grant");
    const texts = rows.map((row) => row.textContent);
    expect(texts.slice(0, 2)).toEqual([
      "Read your work item.Always",
      "Add or remove labels on your work item, with the label bug.From step Implement",
    ]);
    expect(texts[2]).toMatch(/^Comment on your work item\.Approved by alex, /);
  });

  test("renders nothing for a Task with no grants", async () => {
    const task = { ...buildTask(), grants: [] };
    const view = render(
      await withProjectRoute(<TaskAccessSection task={task as never} />),
    );
    expect(view.queryByTestId("task-access")).toBeNull();
  });
});

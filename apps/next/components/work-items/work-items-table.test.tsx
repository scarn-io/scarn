import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { JSDOM } from "jsdom";
import type { WorkItemListItemContract } from "@scarn/api/frontend-contracts";
import { taskStatusChips, WorkItemsTable } from "./work-items-table";
import { installDom } from "@/tests/support/install-dom";

const id = (suffix: string) => `01966a2c-9494-7db5-aa46-0f8f5cbbe${suffix}`;

function buildListItem(
  overrides: Record<string, unknown> = {},
): WorkItemListItemContract {
  return {
    id: id("001"),
    projectId: id("000"),
    platform: "github",
    platformId: null,
    platformKey: "gh-1",
    url: null,
    title: "Retry logic drops the last job",
    description: "The retry backoff never terminates.",
    sourceCreatedAt: null,
    sourceUpdatedAt: "2026-04-26T10:00:00.000Z",
    fields: null,
    createdByUserId: null,
    createdByUsername: null,
    createdByImage: null,
    parentWorkItemId: null,
    labels: [] as string[],
    createdAt: "2026-04-26T12:00:00.000Z",
    updatedAt: "2026-04-26T12:00:00.000Z",
    signalScore: null,
    latestExecutionStatus: null,
    awaitingApprovalCount: 0,
    assignee: null,
    taskStatusCounts: {
      running: 0,
      queued: 0,
      waitingForPerson: 0,
      waitingOnYou: 0,
      waitingForWork: 0,
      failed: 0,
    },
    ...overrides,
  } as WorkItemListItemContract;
}

const ZERO_COUNTS = {
  running: 0,
  queued: 0,
  waitingForPerson: 0,
  waitingOnYou: 0,
  waitingForWork: 0,
  failed: 0,
};

describe("taskStatusChips", () => {
  test("hides zero counts", () => {
    expect(taskStatusChips(ZERO_COUNTS)).toEqual([]);
  });

  test("splits waiting-on-you out of the generic waiting count, most urgent first", () => {
    expect(
      taskStatusChips({
        running: 2,
        queued: 1,
        waitingForPerson: 3,
        waitingOnYou: 1,
        waitingForWork: 1,
        failed: 1,
      }),
    ).toEqual([
      { label: "1 waiting on you", color: "error" },
      { label: "2 waiting", color: "warning" },
      { label: "1 failed", color: "error" },
      { label: "2 running", color: "info" },
      { label: "1 queued", color: "default" },
      { label: "1 blocked", color: "default" },
    ]);
  });

  test("omits the generic waiting chip when every waiting Task waits on you", () => {
    expect(
      taskStatusChips({ ...ZERO_COUNTS, waitingForPerson: 2, waitingOnYou: 2 }),
    ).toEqual([{ label: "2 waiting on you", color: "error" }]);
  });
});

describe("WorkItemsTable", () => {
  let dom: JSDOM;

  beforeEach(() => {
    dom = installDom({ url: "https://app.scarn.io/" });

    Object.assign(globalThis, {
      location: dom.window.location,
    });
  });

  afterEach(() => {
    cleanup();
    dom.window.close();
  });

  test("renders a chip per label beside the title", () => {
    const view = render(
      <WorkItemsTable
        workItems={[buildListItem({ labels: ["bug", "Needs Triage"] })]}
        workItemHrefPrefix="/tester/demo/work-items"
      />,
    );

    expect(view.getByText("bug")).toBeTruthy();
    expect(view.getByText("Needs Triage")).toBeTruthy();
  });

  test("clicking a label chip filters by that label", () => {
    const clicked: string[] = [];
    const view = render(
      <WorkItemsTable
        workItems={[buildListItem({ labels: ["bug", "ui"] })]}
        workItemHrefPrefix="/tester/demo/work-items"
        onLabelClick={(label) => {
          clicked.push(label);
        }}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: "Filter by label ui" }));

    expect(clicked).toEqual(["ui"]);
  });

  test("suppresses the badge entirely when the count is zero", () => {
    const view = render(
      <WorkItemsTable
        workItems={[buildListItem({ awaitingApprovalCount: 0 })]}
        workItemHrefPrefix="/tester/demo/work-items"
      />,
    );

    expect(view.queryByText(/Awaiting approval/)).toBeNull();
  });

  test("renders the bare label, with no count, for exactly one draft", () => {
    const view = render(
      <WorkItemsTable
        workItems={[buildListItem({ awaitingApprovalCount: 1 })]}
        workItemHrefPrefix="/tester/demo/work-items"
      />,
    );

    expect(view.getByText("Awaiting approval")).toBeTruthy();
    expect(view.queryByText("Awaiting approval (1)")).toBeNull();
  });

  test("appends the count once there is more than one draft", () => {
    const view = render(
      <WorkItemsTable
        workItems={[buildListItem({ awaitingApprovalCount: 3 })]}
        workItemHrefPrefix="/tester/demo/work-items"
      />,
    );

    expect(view.getByText("Awaiting approval (3)")).toBeTruthy();
  });

  test("heads the run column as the latest run, beside Agent and Assignee", () => {
    const view = render(
      <WorkItemsTable
        workItems={[buildListItem()]}
        workItemHrefPrefix="/tester/demo/work-items"
      />,
    );

    const headers = view
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    expect(headers).toContain("Latest run");
    expect(headers).toContain("Agent");
    expect(headers).toContain("Assignee");
    expect(headers).not.toContain("Status");
  });

  test("shows a stored `active` run as running", () => {
    const view = render(
      <WorkItemsTable
        workItems={[buildListItem({ latestExecutionStatus: "active" })]}
        workItemHrefPrefix="/tester/demo/work-items"
      />,
    );

    expect(view.getByText("Running")).toBeTruthy();
  });

  test("renders the assignee's username", () => {
    const view = render(
      <WorkItemsTable
        workItems={[
          buildListItem({
            assignee: { userId: id("002"), username: "pam", image: null },
          }),
        ]}
        workItemHrefPrefix="/tester/demo/work-items"
      />,
    );

    expect(view.getByText("pam")).toBeTruthy();
  });

  test("renders Task status chips in the Agent column", () => {
    const view = render(
      <WorkItemsTable
        workItems={[
          buildListItem({
            taskStatusCounts: {
              ...ZERO_COUNTS,
              waitingForPerson: 1,
              waitingOnYou: 1,
            },
          }),
        ]}
        workItemHrefPrefix="/tester/demo/work-items"
      />,
    );

    expect(view.getByText("1 waiting on you")).toBeTruthy();
  });
});

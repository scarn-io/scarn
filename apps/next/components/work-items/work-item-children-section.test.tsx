import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  waitForElementToBeRemoved,
  within,
} from "@testing-library/react";
import type {
  ChildWorkItemContract,
  ChildWorkItemLatestTaskContract,
  WorkItemContract,
} from "@scarn/api/frontend-contracts";
import { installDom } from "@/tests/support/install-dom";

// `WorkItemChildrenSection` reads `work-items/:id/children` and unlinks a
// child through `parent.patch`. The picker dialog behind Add searches through
// `project-work-items`, mocked so it opens without a network.

type ApiResult<T> = { data: T; error: unknown };

let childrenResult: ApiResult<ChildWorkItemContract[]> = {
  data: [],
  error: null,
};
const childrenGetMock = mock(() => Promise.resolve(childrenResult));
const parentPatchMock = mock(() =>
  Promise.resolve({ data: null, error: null }),
);

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      "work-items": () => ({
        children: { get: childrenGetMock },
        parent: { patch: parentPatchMock },
      }),
    },
  }),
}));

void mock.module("@/app/(protected)/projects/_lib/project-work-items", () => ({
  fetchProjectWorkItems: () =>
    Promise.resolve({
      items: [],
      pagination: { page: 1, pageSize: 10, total: 0 },
    }),
  fetchWorkItem: () => Promise.reject(new Error("not found")),
}));

const { WorkItemChildrenSection } =
  await import("./work-item-children-section");
const { useWorkItemChildren } = await import("./use-work-item-children");
const { ProjectRouteProvider } =
  await import("@/components/project-route-context");

const PROJECT_ID = "01966a2c-9494-7db5-aa46-0f8f5cbbe000";
const id = (suffix: string) => `01966a2c-9494-7db5-aa46-0f8f5cbbe${suffix}`;
const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const buildWorkItem = (
  overrides: Record<string, unknown> = {},
): WorkItemContract =>
  ({
    id: id("001"),
    projectId: PROJECT_ID,
    platform: "scarn",
    platformKey: "manual-1",
    title: "Parent map",
    description: "The map.",
    labels: [],
    state: "open",
    resolution: null,
    parentWorkItemId: null,
    createdAt: "2026-04-26T12:00:00.000Z",
    updatedAt: "2026-04-26T12:00:00.000Z",
    ...overrides,
  }) as unknown as WorkItemContract;

const buildTask = (
  overrides: Record<string, unknown> = {},
): ChildWorkItemLatestTaskContract =>
  ({
    id: id("901"),
    status: "running",
    step: { key: "research", name: "Research" },
    startedAt: minutesAgo(5),
    updatedAt: minutesAgo(5),
    question: null,
    failure: null,
    ...overrides,
  }) as unknown as ChildWorkItemLatestTaskContract;

const buildChild = (
  overrides: Record<string, unknown>,
): ChildWorkItemContract =>
  ({
    ...buildWorkItem({ parentWorkItemId: id("001") }),
    status: "ready",
    assignee: null,
    openBlockers: [],
    latestTask: null,
    ...overrides,
  }) as unknown as ChildWorkItemContract;

function SectionWithChildren() {
  const workItem = buildWorkItem();
  const childrenData = useWorkItemChildren(workItem.id);
  return (
    <WorkItemChildrenSection
      projectId={PROJECT_ID}
      workItem={workItem}
      childrenData={childrenData}
    />
  );
}

const renderSection = (isMember = true) =>
  render(
    <ProjectRouteProvider
      username="tester"
      projectSlug="demo"
      projectId={PROJECT_ID}
      isMember={isMember}
    >
      <SectionWithChildren />
    </ProjectRouteProvider>,
  );

const groupTitles = (view: ReturnType<typeof render>) =>
  view
    .getAllByTestId(/^child-group-/)
    .map((group) => group.getAttribute("data-testid"));

describe("WorkItemChildrenSection", () => {
  beforeEach(() => {
    const dom = installDom({ url: "https://app.scarn.io/" });
    Object.assign(globalThis, {
      ResizeObserver: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
      requestAnimationFrame: (cb: FrameRequestCallback) =>
        setTimeout(() => {
          cb(Date.now());
        }, 0) as unknown as number,
      cancelAnimationFrame: (handle: number) => {
        clearTimeout(handle);
      },
    });
    // React 19's input polyfill calls these IE-only methods when the
    // picker's search field takes focus.
    type WithIeEvents = { attachEvent?: () => void; detachEvent?: () => void };
    const element = dom.window.Element.prototype as unknown as WithIeEvents;
    element.attachEvent = () => {};
    element.detachEvent = () => {};

    childrenResult = { data: [], error: null };
    childrenGetMock.mockClear();
    parentPatchMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  test("with no children a member sees only the Add child work item link, which opens the picker", async () => {
    const view = renderSection();

    const link = await waitFor(() =>
      view.getByRole("button", { name: "Add child work item" }),
    );
    expect(view.queryByText("Child work items")).toBeNull();

    fireEvent.click(link);
    await waitFor(() => {
      expect(
        view.getByRole("heading", { name: "Add child work item" }),
      ).toBeTruthy();
    });
  });

  test("with no children a non-member sees nothing", async () => {
    const view = renderSection(false);
    await waitFor(() => {
      expect(childrenGetMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(view.container.textContent).toBe("");
    });
  });

  test("groups children in status order with counts, hides empty groups and keeps creation order", async () => {
    childrenResult = {
      data: [
        buildChild({ id: id("201"), title: "Closed one", status: "closed" }),
        buildChild({ id: id("202"), title: "Ready A", status: "ready" }),
        buildChild({
          id: id("203"),
          title: "Needs one",
          status: "needs_person",
        }),
        buildChild({ id: id("204"), title: "Ready B", status: "ready" }),
        buildChild({
          id: id("205"),
          title: "Running one",
          status: "running",
          latestTask: buildTask(),
        }),
      ],
      error: null,
    };
    const view = renderSection();

    await waitFor(() => {
      expect(view.getByText("Ready A")).toBeTruthy();
    });

    expect(view.getByText("1 of 5 closed")).toBeTruthy();
    expect(groupTitles(view)).toEqual([
      "child-group-needs_person",
      "child-group-running",
      "child-group-ready",
      "child-group-closed",
    ]);

    const ready = within(view.getByTestId("child-group-ready"));
    expect(ready.getByText("2")).toBeTruthy();
    expect(
      ready
        .getAllByTestId("child-work-item-row")
        .map((row) => row.querySelector("a")?.textContent),
    ).toEqual(["Ready A", "Ready B"]);

    const bar = view.getByRole("progressbar", {
      name: "Child work items closed",
    });
    expect(
      Array.from(bar.querySelectorAll("[data-status]")).map((segment) =>
        segment.getAttribute("data-status"),
      ),
    ).toEqual(["needs_person", "running", "ready", "closed"]);
  });

  test("Closed starts collapsed and expands on click", async () => {
    childrenResult = {
      data: [
        buildChild({
          id: id("201"),
          title: "Done child",
          status: "closed",
          state: "closed",
          resolution: "Shipped in\n  the release.",
        }),
      ],
      error: null,
    };
    const view = renderSection();

    await waitFor(() => {
      expect(view.getByText("Closed")).toBeTruthy();
    });
    expect(view.queryByText("Done child")).toBeNull();

    fireEvent.click(view.getByText("Closed"));
    expect(view.getByText("Done child")).toBeTruthy();
    expect(view.getByText("Shipped in the release.")).toBeTruthy();
  });

  test("shows each Needs a person second line", async () => {
    childrenResult = {
      data: [
        buildChild({
          id: id("201"),
          title: "Asked",
          status: "needs_person",
          latestTask: buildTask({
            status: "waiting_for_person",
            question: "Which database should we use?",
          }),
        }),
        buildChild({
          id: id("202"),
          title: "Review",
          status: "needs_person",
          latestTask: buildTask({ status: "waiting_for_person" }),
        }),
        buildChild({
          id: id("203"),
          title: "Broke",
          status: "needs_person",
          latestTask: buildTask({
            status: "failed",
            failure: "exit code 1",
            updatedAt: minutesAgo(25),
          }),
        }),
        buildChild({
          id: id("204"),
          title: "Untouched",
          status: "needs_person",
        }),
      ],
      error: null,
    };
    const view = renderSection();

    await waitFor(() => {
      expect(view.getByText("Which database should we use?")).toBeTruthy();
    });
    expect(view.getByText("Ready for review")).toBeTruthy();
    expect(
      view.getByText("Run failed: exit code 1 · 25 minutes ago"),
    ).toBeTruthy();
    expect(
      view.getByText("Nothing started · do this by hand, or start a step"),
    ).toBeTruthy();
  });

  test("shows the Running step and how long it has run, and Blocked's blockers as links", async () => {
    childrenResult = {
      data: [
        buildChild({
          id: id("201"),
          title: "Researching",
          status: "running",
          latestTask: buildTask({ startedAt: minutesAgo(3) }),
        }),
        buildChild({
          id: id("202"),
          title: "Waiting",
          status: "blocked",
          openBlockers: [
            { id: id("301"), title: "Schema first" },
            { id: id("302"), title: "Auth first" },
          ],
        }),
      ],
      error: null,
    };
    const view = renderSection();

    await waitFor(() => {
      expect(view.getByText(/Research · running for 3m/)).toBeTruthy();
    });
    const blocked = within(view.getByTestId("child-group-blocked"));
    expect(blocked.getByText(/Blocked by/)).toBeTruthy();
    expect(
      blocked.getByRole("link", { name: "Schema first" }).getAttribute("href"),
    ).toBe(`/tester/demo/work-items/${id("301")}`);
    expect(blocked.getByRole("link", { name: "Auth first" })).toBeTruthy();
  });

  test("Add opens the picker from the header", async () => {
    childrenResult = {
      data: [buildChild({ id: id("201"), title: "Child A" })],
      error: null,
    };
    const view = renderSection();

    await waitFor(() => {
      expect(view.getByText("Child A")).toBeTruthy();
    });
    fireEvent.click(view.getByRole("button", { name: "Add" }));
    await waitFor(() => {
      expect(
        view.getByRole("heading", { name: "Add child work item" }),
      ).toBeTruthy();
    });
  });

  test("Remove unlinks the child and drops its row", async () => {
    childrenResult = {
      data: [buildChild({ id: id("201"), title: "Child A" })],
      error: null,
    };
    const view = renderSection();

    await waitFor(() => {
      expect(view.getByText("Child A")).toBeTruthy();
    });
    fireEvent.click(
      view.getByRole("button", { name: "Child work item actions" }),
    );
    expect(view.getByText("Copy link")).toBeTruthy();
    fireEvent.click(view.getByText("Remove"));

    await waitForElementToBeRemoved(() => view.queryByText("Child A"));
    expect(parentPatchMock).toHaveBeenCalledWith({ parentWorkItemId: null });
  });
});

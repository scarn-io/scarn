import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { WorkItemContract } from "@scarn/api/frontend-contracts";
import type { WorkItemBlockContract } from "@scarn/core/work-items/work-item-block/contracts/work-item-block-contracts";
import { installDom } from "@/tests/support/install-dom";

// ─── project-work-items mock (parent lookup + resolved counterpart titles +
// the picker dialog's own search) ──────────────────────────────────────────

let workItemGetResultsById: Record<string, WorkItemContract | null> = {};
const fetchWorkItemMock = mock((workItemId: string) => {
  const item = workItemGetResultsById[workItemId];
  return item ? Promise.resolve(item) : Promise.reject(new Error("not found"));
});
const fetchProjectWorkItemsMock = mock(() =>
  Promise.resolve({
    items: [],
    pagination: { page: 1, pageSize: 10, total: 0 },
  }),
);

void mock.module("@/app/(protected)/projects/_lib/project-work-items", () => ({
  fetchWorkItem: fetchWorkItemMock,
  fetchProjectWorkItems: fetchProjectWorkItemsMock,
}));

// ─── API client mock ──────────────────────────────────────────────────────────

type ApiResult<T> = { data: T; error: unknown };

let blocksResult: ApiResult<{
  blockedBy: WorkItemBlockContract[];
  blocking: WorkItemBlockContract[];
}> = { data: { blockedBy: [], blocking: [] }, error: null };
const blocksGetMock = mock(() => Promise.resolve(blocksResult));
const blockDeleteMock = mock(() =>
  Promise.resolve({ data: null, error: null }),
);
const parentPatchMock = mock(
  (): Promise<{ data: WorkItemContract | null; error: unknown }> =>
    Promise.resolve({ data: null, error: null }),
);

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      "work-items": () => ({
        parent: { patch: parentPatchMock },
      }),
      "work-item-blocks": Object.assign(() => ({ delete: blockDeleteMock }), {
        get: blocksGetMock,
      }),
    },
  }),
}));

const { WorkItemSidebarRelationships } =
  await import("./work-item-sidebar-relationships");
const { ProjectRouteProvider } =
  await import("@/components/project-route-context");

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PROJECT_ID = "01966a2c-9494-7db5-aa46-0f8f5cbbe000";

const id = (suffix: string) => `01966a2c-9494-7db5-aa46-0f8f5cbbe${suffix}`;

const buildWorkItem = (
  overrides: Record<string, unknown> = {},
): WorkItemContract =>
  ({
    id: id("001"),
    projectId: PROJECT_ID,
    platform: "github",
    platformId: null,
    platformKey: "gh-1",
    url: null,
    title: "Investigate flaky test",
    description: "Repro steps go here.",
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    fields: null,
    createdByUserId: null,
    createdByUsername: null,
    createdByImage: null,
    parentWorkItemId: null,
    createdAt: "2026-04-26T12:00:00.000Z",
    updatedAt: "2026-04-26T12:00:00.000Z",
    ...overrides,
  }) as WorkItemContract;

const buildBlock = (
  overrides: Record<string, unknown> = {},
): WorkItemBlockContract =>
  ({
    id: id("601"),
    projectId: PROJECT_ID,
    blockedWorkItemId: id("001"),
    blockingWorkItemId: id("701"),
    createdByUserId: null,
    createdAt: "2026-04-26T12:00:00.000Z",
    ...overrides,
  }) as WorkItemBlockContract;

const renderSidebar = ({
  workItem,
  isMember = true,
  onWorkItemChanged = () => {},
}: {
  workItem: WorkItemContract;
  isMember?: boolean;
  onWorkItemChanged?: (updated: WorkItemContract) => void;
}) =>
  render(
    <ProjectRouteProvider
      username="tester"
      projectSlug="demo"
      projectId={PROJECT_ID}
      isMember={isMember}
    >
      <WorkItemSidebarRelationships
        projectId={PROJECT_ID}
        workItem={workItem}
        onWorkItemChanged={onWorkItemChanged}
      />
    </ProjectRouteProvider>,
  );

describe("WorkItemSidebarRelationships", () => {
  beforeEach(() => {
    installDom({ url: "https://app.scarn.io/" });

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
      cancelAnimationFrame: (idHandle: number) => {
        clearTimeout(idHandle);
      },
    });

    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string): MediaQueryList =>
        ({
          addEventListener() {},
          addListener() {},
          dispatchEvent() {
            return false;
          },
          matches: false,
          media: query,
          onchange: null,
          removeEventListener() {},
          removeListener() {},
        }) as MediaQueryList,
    });

    workItemGetResultsById = {};
    blocksResult = { data: { blockedBy: [], blocking: [] }, error: null };
    fetchWorkItemMock.mockClear();
    fetchProjectWorkItemsMock.mockClear();
    blocksGetMock.mockClear();
    blockDeleteMock.mockClear();
    parentPatchMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  test("renders a quiet 'None yet.' with no persistent button for an item with nothing set", async () => {
    const item = buildWorkItem({ parentWorkItemId: null });
    const view = renderSidebar({ workItem: item, isMember: true });

    await waitFor(() => {
      expect(view.getByText("None yet.")).toBeTruthy();
    });

    // No always-visible "Add"/"Set parent" button — only the "Relationships"
    // header itself opens the dropdown (Decision: quiet-until-clicked).
    expect(view.queryByRole("button")).toBeNull();
  });

  test("a non-member sees 'None yet.' with no clickable dropdown", async () => {
    const item = buildWorkItem({ parentWorkItemId: null });
    const view = renderSidebar({ workItem: item, isMember: false });

    await waitFor(() => {
      expect(view.getByText("None yet.")).toBeTruthy();
    });

    fireEvent.click(view.getByText("Relationships"));
    expect(view.queryByText("Mark as blocked by")).toBeNull();
  });

  test("clicking the Relationships header opens a dropdown with all three actions", async () => {
    const item = buildWorkItem({ parentWorkItemId: null });
    const view = renderSidebar({ workItem: item, isMember: true });

    await waitFor(() => {
      expect(view.getByText("None yet.")).toBeTruthy();
    });

    fireEvent.click(view.getByText("Relationships"));

    expect(view.getByText("Set parent work item")).toBeTruthy();
    expect(view.getByText("Mark as blocked by")).toBeTruthy();
    expect(view.getByText("Mark as blocking")).toBeTruthy();
  });

  test("shows the parent row with a Remove action for a member", async () => {
    const parentId = id("501");
    const parent = buildWorkItem({ id: parentId, title: "Parent epic" });
    workItemGetResultsById = { [parentId]: parent };

    const item = buildWorkItem({ parentWorkItemId: parentId });
    const view = renderSidebar({ workItem: item, isMember: true });

    await waitFor(() => {
      expect(view.getByText("Parent epic")).toBeTruthy();
    });

    fireEvent.click(view.getByRole("button", { name: "Relationship actions" }));
    expect(view.getByText("Remove parent")).toBeTruthy();
  });

  test("removing the parent calls onWorkItemChanged with the updated item", async () => {
    const parentId = id("501");
    const parent = buildWorkItem({ id: parentId, title: "Parent epic" });
    workItemGetResultsById = { [parentId]: parent };
    const updated = buildWorkItem({ parentWorkItemId: null });
    parentPatchMock.mockImplementation(() =>
      Promise.resolve({ data: updated, error: null }),
    );

    const item = buildWorkItem({ parentWorkItemId: parentId });
    const onWorkItemChanged = mock(() => {});
    const view = renderSidebar({
      workItem: item,
      isMember: true,
      onWorkItemChanged,
    });

    await waitFor(() => {
      expect(view.getByText("Parent epic")).toBeTruthy();
    });

    fireEvent.click(view.getByRole("button", { name: "Relationship actions" }));
    fireEvent.click(view.getByText("Remove parent"));

    await waitFor(() => {
      expect(onWorkItemChanged).toHaveBeenCalledWith(updated);
    });
  });

  test("renders Blocked-by and Blocking rows once counterpart titles resolve", async () => {
    const item = buildWorkItem({ parentWorkItemId: null });
    const blockedByCounterpart = buildWorkItem({
      id: id("701"),
      title: "Blocking dependency",
    });
    const blockingCounterpart = buildWorkItem({
      id: id("801"),
      title: "Downstream item",
    });
    workItemGetResultsById = {
      [blockedByCounterpart.id]: blockedByCounterpart,
      [blockingCounterpart.id]: blockingCounterpart,
    };
    blocksResult = {
      data: {
        blockedBy: [
          buildBlock({
            id: id("601"),
            blockedWorkItemId: item.id,
            blockingWorkItemId: blockedByCounterpart.id,
          }),
        ],
        blocking: [
          buildBlock({
            id: id("602"),
            blockedWorkItemId: blockingCounterpart.id,
            blockingWorkItemId: item.id,
          }),
        ],
      },
      error: null,
    };

    const view = renderSidebar({ workItem: item, isMember: true });

    await waitFor(() => {
      expect(view.getByText("Blocking dependency")).toBeTruthy();
    });
    expect(view.getByText("Downstream item")).toBeTruthy();
    expect(view.getByText("Blocked by")).toBeTruthy();
    expect(view.getByText("Blocking")).toBeTruthy();
  });
});

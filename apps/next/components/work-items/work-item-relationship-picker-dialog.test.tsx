import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type {
  WorkItemContract,
  WorkItemListItemContract,
} from "@scarn/api/frontend-contracts";
import { installDom } from "@/tests/support/install-dom";

// ─── project-work-items mock (search + parent-title batch lookup) ────────────
//
// `WorkItemRelationshipPickerDialog` imports `fetchProjectWorkItems` and
// `fetchWorkItem` directly from this module (not through the API client), so
// it's mocked directly rather than through `getBrowserScarnApiClient()`.

let searchItems: WorkItemListItemContract[] = [];
const fetchProjectWorkItemsMock = mock(() =>
  Promise.resolve({
    items: searchItems,
    pagination: { page: 1, pageSize: 10, total: searchItems.length },
  }),
);

let parentTitleById: Record<string, string> = {};
const fetchWorkItemMock = mock((workItemId: string) =>
  Promise.resolve(
    buildWorkItem({
      id: workItemId,
      title: parentTitleById[workItemId] ?? "Unresolved parent",
    }),
  ),
);

void mock.module("@/app/(protected)/projects/_lib/project-work-items", () => ({
  fetchProjectWorkItems: fetchProjectWorkItemsMock,
  fetchWorkItem: fetchWorkItemMock,
}));

// ─── API client mock (submit-time mutations only) ─────────────────────────────

type ApiResult = { data: unknown; error: unknown };

let parentPatchImpl: () => Promise<ApiResult> = () =>
  Promise.resolve({ data: null, error: null });
let blockPostImpl: () => Promise<ApiResult> = () =>
  Promise.resolve({ data: null, error: null });

const parentPatchMock = mock(() => parentPatchImpl());
const blockPostMock = mock(() => blockPostImpl());

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      "work-items": () => ({
        parent: { patch: parentPatchMock },
      }),
      "work-item-blocks": {
        post: blockPostMock,
      },
    },
  }),
}));

const { WorkItemRelationshipPickerDialog } =
  await import("./work-item-relationship-picker-dialog");

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const id = (suffix: string) => `01966a2c-9494-7db5-aa46-0f8f5cbbe${suffix}`;

// `overrides` is intentionally loosely typed (`Record<string, unknown>`
// rather than `Partial<WorkItemContract>`): `id`/`projectId`/
// `parentWorkItemId` are branded (`WorkItemId`/`UuidV7`) in the real
// contract, and these fixtures pass plain test UUID strings for them.
function buildWorkItem(
  overrides: Record<string, unknown> = {},
): WorkItemContract {
  return {
    id: id("001"),
    projectId: id("000"),
    platform: "github",
    platformId: null,
    platformKey: "gh-1",
    url: null,
    title: "Current work item",
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
  } as WorkItemContract;
}

function buildListItem(
  overrides: Record<string, unknown> = {},
): WorkItemListItemContract {
  return {
    ...buildWorkItem(),
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
  };
}

// ─── Deferred promise helper (pessimistic-submit tests) ───────────────────────

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// ─── DOM setup helper ──────────────────────────────────────────────────────────

function setupDom() {
  const dom = installDom({ url: "https://app.scarn.io/" });

  Object.assign(globalThis, {
    // jsdom implements neither; MUI's Autocomplete/TextField need both to
    // mount/unmount without throwing.
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

  // Stub IE-only event methods that React 19's input polyfill tries to call.
  type WithIeEvents = { attachEvent?: () => void; detachEvent?: () => void };
  (
    dom.window.HTMLInputElement.prototype as unknown as WithIeEvents
  ).attachEvent = () => {};
  (
    dom.window.HTMLInputElement.prototype as unknown as WithIeEvents
  ).detachEvent = () => {};
  (dom.window.Element.prototype as unknown as WithIeEvents).attachEvent =
    () => {};
  (dom.window.Element.prototype as unknown as WithIeEvents).detachEvent =
    () => {};
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("WorkItemRelationshipPickerDialog", () => {
  beforeEach(() => {
    setupDom();
    searchItems = [];
    parentTitleById = {};
    parentPatchImpl = () => Promise.resolve({ data: null, error: null });
    blockPostImpl = () => Promise.resolve({ data: null, error: null });
    fetchProjectWorkItemsMock.mockClear();
    fetchWorkItemMock.mockClear();
    parentPatchMock.mockClear();
    blockPostMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  test("excludes excludeIds and the current work item from the search results", async () => {
    const currentItem = buildWorkItem({ id: id("001") });
    const excluded = buildListItem({
      id: id("101"),
      title: "Excluded candidate",
    });
    const visible = buildListItem({
      id: id("102"),
      title: "Visible candidate",
    });
    searchItems = [
      buildListItem({ id: currentItem.id, title: currentItem.title }),
      excluded,
      visible,
    ];

    const view = render(
      <WorkItemRelationshipPickerDialog
        open
        onClose={() => {}}
        projectId={id("000")}
        workItem={currentItem}
        mode={{ kind: "child" }}
        excludeIds={new Set([excluded.id])}
        onLinked={() => {}}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: "Open" }));

    await waitFor(() => {
      expect(view.getByText("Visible candidate")).toBeTruthy();
    });

    expect(view.queryByText("Excluded candidate")).toBeNull();
    expect(view.queryByText("Current work item")).toBeNull();
  });

  test("block mode toggles direction between Blocked by and Blocking", async () => {
    const currentItem = buildWorkItem({ id: id("001") });

    const view = render(
      <WorkItemRelationshipPickerDialog
        open
        onClose={() => {}}
        projectId={id("000")}
        workItem={currentItem}
        mode={{ kind: "block", initialDirection: "blocking" }}
        excludeIds={new Set()}
        onLinked={() => {}}
      />,
    );

    expect(
      view.getByRole("button", { name: "Blocking", pressed: true }),
    ).toBeTruthy();
    expect(
      view.getByRole("button", { name: "Blocked by", pressed: false }),
    ).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Blocked by" }));

    await waitFor(() => {
      expect(
        view.getByRole("button", { name: "Blocked by", pressed: true }),
      ).toBeTruthy();
    });
    expect(
      view.getByRole("button", { name: "Blocking", pressed: false }),
    ).toBeTruthy();
  });

  test("child mode shows an 'already under' caption for a candidate with a different parent", async () => {
    const currentItem = buildWorkItem({ id: id("001") });
    const otherParentId = id("501");
    parentTitleById[otherParentId] = "Some other epic";
    const candidate = buildListItem({
      id: id("102"),
      title: "Reparent candidate",
      parentWorkItemId: otherParentId,
    });
    searchItems = [candidate];

    const view = render(
      <WorkItemRelationshipPickerDialog
        open
        onClose={() => {}}
        projectId={id("000")}
        workItem={currentItem}
        mode={{ kind: "child" }}
        excludeIds={new Set()}
        onLinked={() => {}}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: "Open" }));

    await waitFor(() => {
      expect(view.getByText("already under: Some other epic")).toBeTruthy();
    });
  });

  test("pessimistic submit: confirm disables and shows a spinner while in flight, then closes on success", async () => {
    const currentItem = buildWorkItem({ id: id("001") });
    const candidate = buildListItem({
      id: id("102"),
      title: "Visible candidate",
    });
    searchItems = [candidate];

    const gate = deferred<ApiResult>();
    parentPatchImpl = () => gate.promise;

    const onLinked = mock(() => {});
    const onClose = mock(() => {});

    const view = render(
      <WorkItemRelationshipPickerDialog
        open
        onClose={onClose}
        projectId={id("000")}
        workItem={currentItem}
        mode={{ kind: "parent" }}
        excludeIds={new Set()}
        onLinked={onLinked}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: "Open" }));
    await waitFor(() => {
      expect(view.getByText("Visible candidate")).toBeTruthy();
    });
    fireEvent.click(view.getByText("Visible candidate"));

    const confirmButton = view.getByRole("button", { name: "Set parent" });
    await waitFor(() => {
      expect(confirmButton.hasAttribute("disabled")).toBe(false);
    });

    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(confirmButton.hasAttribute("disabled")).toBe(true);
    });
    expect(confirmButton.querySelector('[role="progressbar"]')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    const updatedItem = buildWorkItem({
      id: currentItem.id,
      parentWorkItemId: candidate.id,
    });
    gate.resolve({ data: updatedItem, error: null });

    await waitFor(() => {
      expect(onLinked).toHaveBeenCalledWith(updatedItem);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("pessimistic submit: a failed mutation shows an inline error Alert and keeps the dialog open", async () => {
    const currentItem = buildWorkItem({ id: id("001") });
    const candidate = buildListItem({
      id: id("102"),
      title: "Visible candidate",
    });
    searchItems = [candidate];

    parentPatchImpl = () => Promise.resolve({ data: null, error: {} });

    const onLinked = mock(() => {});
    const onClose = mock(() => {});

    const view = render(
      <WorkItemRelationshipPickerDialog
        open
        onClose={onClose}
        projectId={id("000")}
        workItem={currentItem}
        mode={{ kind: "parent" }}
        excludeIds={new Set()}
        onLinked={onLinked}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: "Open" }));
    await waitFor(() => {
      expect(view.getByText("Visible candidate")).toBeTruthy();
    });
    fireEvent.click(view.getByText("Visible candidate"));

    const confirmButton = view.getByRole("button", { name: "Set parent" });
    await waitFor(() => {
      expect(confirmButton.hasAttribute("disabled")).toBe(false);
    });

    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(view.getByText("Could not set parent. Try again.")).toBeTruthy();
    });

    expect(onLinked).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // `isPending` (from `useTransition`) settles to `false` in a commit that
    // can trail the one that sets the error Alert, so re-enabling the button
    // is asserted with `waitFor` rather than immediately after the Alert.
    await waitFor(() => {
      expect(confirmButton.hasAttribute("disabled")).toBe(false);
    });
  });
});

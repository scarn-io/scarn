import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { WorkItemContract } from "@scarn/api/frontend-contracts";
import type { WorkItemRingStatus } from "./work-item-status-ring";
import { installDom } from "@/tests/support/install-dom";

const { WorkItemDetailHeader } = await import("./work-item-detail-header");
const { ProjectRouteProvider } =
  await import("@/components/project-route-context");

const workItem = {
  id: "01966a2c-9494-7db5-aa46-0f8f5cbbe001",
  title: "Investigate flaky test",
  platform: "scarn",
  platformKey: "BOB-1",
  parentWorkItemId: null,
  state: "open",
  closeReason: null,
  sourceUpdatedAt: null,
  updatedAt: "2026-04-26T12:00:00.000Z",
} as WorkItemContract;

const renderHeader = (
  overrides: {
    workItem?: WorkItemContract;
    ringStatus?: WorkItemRingStatus;
    showNotifications?: boolean;
    onStateChanged?: () => void;
    onOpenNotifications?: () => void;
    onOpenExecutions?: () => void;
  } = {},
) =>
  render(
    <ProjectRouteProvider
      username="tester"
      projectSlug="demo"
      projectId="01966a2c-9494-7db5-aa46-0f8f5cbbe000"
      isMember
      permissions={[]}
    >
      <WorkItemDetailHeader
        workItem={overrides.workItem ?? workItem}
        ringStatus={overrides.ringStatus ?? "open"}
        showNotifications={overrides.showNotifications}
        notificationCount={3}
        executionCount={1}
        onOpenNotifications={overrides.onOpenNotifications ?? (() => {})}
        onOpenExecutions={overrides.onOpenExecutions ?? (() => {})}
        onStateChanged={overrides.onStateChanged}
      />
    </ProjectRouteProvider>,
  );

describe("WorkItemDetailHeader", () => {
  beforeEach(() => {
    installDom({ url: "https://app.scarn.io/" });
  });

  afterEach(() => {
    cleanup();
  });

  test("the breadcrumb links back to Work Items and ends at the title", () => {
    const view = renderHeader();

    const breadcrumb = view.getByRole("navigation", { name: "Breadcrumb" });
    expect(
      view.getByRole("link", { name: "Work Items" }).getAttribute("href"),
    ).toBe("/tester/demo/work-items");
    expect(breadcrumb.querySelector("[aria-current='page']")?.textContent).toBe(
      "Investigate flaky test",
    );
  });

  test("shows the key, the platform and the title", () => {
    const view = renderHeader();

    expect(view.getByText("BOB-1")).toBeTruthy();
    expect(
      view.getByRole("heading", { name: "Investigate flaky test" }),
    ).toBeTruthy();
  });

  test("the status ring is labelled with the viewer's status", () => {
    const view = renderHeader({ ringStatus: "needs_you" });

    expect(view.getByRole("img", { name: "Needs your reply" })).toBeTruthy();
  });

  test("offers Close on an open item only when it can change state", () => {
    const readOnly = renderHeader();
    expect(readOnly.queryByRole("button", { name: "Close" })).toBeNull();
    cleanup();

    const editable = renderHeader({ onStateChanged: () => {} });
    expect(editable.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(editable.queryByRole("button", { name: "Reopen" })).toBeNull();
  });

  test("offers Reopen on a closed item", () => {
    const view = renderHeader({
      workItem: { ...workItem, state: "closed", closeReason: "out_of_scope" },
      onStateChanged: () => {},
    });

    expect(view.getByRole("button", { name: "Reopen" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Close" })).toBeNull();
  });

  test("the More actions menu opens the notifications and pipeline runs drawers", () => {
    const onOpenNotifications = mock(() => {});
    const onOpenExecutions = mock(() => {});
    const view = renderHeader({ onOpenNotifications, onOpenExecutions });

    fireEvent.click(view.getByRole("button", { name: "More actions" }));
    fireEvent.click(
      view.getByRole("menuitem", { name: /Notifications \(3\)/ }),
    );
    expect(onOpenNotifications).toHaveBeenCalledTimes(1);

    fireEvent.click(view.getByRole("button", { name: "More actions" }));
    fireEvent.click(
      view.getByRole("menuitem", { name: /Pipeline runs \(1\)/ }),
    );
    expect(onOpenExecutions).toHaveBeenCalledTimes(1);
  });

  test("hides Notifications from the menu when it isn't shown", () => {
    const view = renderHeader({ showNotifications: false });

    fireEvent.click(view.getByRole("button", { name: "More actions" }));
    expect(view.queryByRole("menuitem", { name: /Notifications/ })).toBeNull();
    expect(view.getByRole("menuitem", { name: /Pipeline runs/ })).toBeTruthy();
  });
});

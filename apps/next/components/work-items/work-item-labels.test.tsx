import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { JSDOM } from "jsdom";
import type { WorkItemContract } from "@scarn/api/frontend-contracts";
import { installDom } from "@/tests/support/install-dom";

const fetchWorkItemLabelsMock = mock(() => Promise.resolve(["bug", "ui"]));

void mock.module("@/app/(protected)/projects/_lib/project-work-items", () => ({
  fetchWorkItemLabels: fetchWorkItemLabelsMock,
}));

const labelsPatchMock = mock(
  (body: {
    add?: string[];
    remove?: string[];
  }): Promise<{ data: WorkItemContract | null; error: unknown }> =>
    Promise.resolve({
      data: { ...buildWorkItem(), labels: body.add ?? [] },
      error: null,
    }),
);

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      "work-items": () => ({ labels: { patch: labelsPatchMock } }),
    },
  }),
}));

const { WorkItemLabels } = await import("./work-item-labels");
const { ProjectRouteProvider } =
  await import("@/components/project-route-context");

const PROJECT_ID = "01966a2c-9494-7db5-aa46-0f8f5cbbe000";

function buildWorkItem(
  overrides: Partial<WorkItemContract> = {},
): WorkItemContract {
  return {
    id: "01966a2c-9494-7db5-aa46-0f8f5cbbe001",
    projectId: PROJECT_ID,
    platform: "scarn",
    platformId: null,
    platformKey: "manual-1",
    url: null,
    title: "Retry logic drops the last job",
    description: "",
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    fields: null,
    createdByUserId: null,
    createdByUsername: null,
    createdByImage: null,
    parentWorkItemId: null,
    labels: [],
    createdAt: "2026-04-26T12:00:00.000Z",
    updatedAt: "2026-04-26T12:00:00.000Z",
    ...overrides,
  } as WorkItemContract;
}

const renderLabels = (
  workItem: WorkItemContract,
  onWorkItemChanged: (updated: WorkItemContract) => void = () => {},
) =>
  render(
    <ProjectRouteProvider
      username="tester"
      projectSlug="demo"
      projectId={PROJECT_ID}
      isMember
      permissions={["work-items:write"]}
    >
      <WorkItemLabels
        projectId={PROJECT_ID}
        workItem={workItem}
        onWorkItemChanged={onWorkItemChanged}
      />
    </ProjectRouteProvider>,
  );

describe("WorkItemLabels", () => {
  let dom: JSDOM;

  beforeEach(() => {
    dom = installDom({ url: "https://app.scarn.io/" });

    // Stub IE-only event methods that React 19's input polyfill tries to call.
    type WithIeEvents = { attachEvent?: () => void; detachEvent?: () => void };
    for (const prototype of [
      dom.window.HTMLInputElement.prototype,
      dom.window.Element.prototype,
    ] as unknown as WithIeEvents[]) {
      prototype.attachEvent = () => {};
      prototype.detachEvent = () => {};
    }

    fetchWorkItemLabelsMock.mockClear();
    labelsPatchMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    dom.window.close();
  });

  test("shows a synced item's labels read-only", () => {
    const view = renderLabels(
      buildWorkItem({ platform: "github", labels: ["bug", "backend"] }),
    );

    expect(view.getByText("bug")).toBeTruthy();
    expect(view.getByText("backend")).toBeTruthy();
    expect(view.queryByLabelText("Add label")).toBeNull();
    expect(view.queryByLabelText("Remove label bug")).toBeNull();
    expect(fetchWorkItemLabelsMock).not.toHaveBeenCalled();
  });

  test("says None for a synced item without labels", () => {
    const view = renderLabels(buildWorkItem({ platform: "jira" }));

    expect(view.getByText("None")).toBeTruthy();
  });

  test("lets a Scarn-created item gain a suggested label", async () => {
    const changed: WorkItemContract[] = [];
    const view = renderLabels(buildWorkItem(), (updated) => {
      changed.push(updated);
    });

    await waitFor(() => {
      expect(fetchWorkItemLabelsMock).toHaveBeenCalledWith(PROJECT_ID);
    });
    fireEvent.mouseDown(view.getByLabelText("Add label"));
    fireEvent.click(await view.findByRole("option", { name: "ui" }));

    await waitFor(() => {
      expect(labelsPatchMock).toHaveBeenCalledWith({ add: ["ui"] });
    });
    await waitFor(() => {
      expect(changed[0]?.labels).toEqual(["ui"]);
    });
  });

  test("lets a Scarn-created item drop a label", async () => {
    const view = renderLabels(buildWorkItem({ labels: ["bug"] }));

    fireEvent.click(view.getByLabelText("Remove label bug"));

    await waitFor(() => {
      expect(labelsPatchMock).toHaveBeenCalledWith({ remove: ["bug"] });
    });
  });
});

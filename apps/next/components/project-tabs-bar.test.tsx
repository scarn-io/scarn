import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import type { JSDOM } from "jsdom";
import { installDom } from "@/tests/support/install-dom";

let mockPathname = "/alice/project-1/work-items";
/**
 * Width the tabs container reports. 320 is deliberately too narrow for the full
 * member tab set (so the overflow test has something to overflow); the tests
 * that care about *which* tabs exist rather than which ones fit widen it.
 */
let mockContainerWidth = 320;

void mock.module("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
  useSearchParams: () => new URLSearchParams(),
}));

let mockBadgeCount = 0;
const summaryCalls: string[] = [];

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      projects: ({ projectId }: { projectId: string }) => ({
        inbox: {
          summary: {
            get: () => {
              summaryCalls.push(projectId);
              return Promise.resolve({
                data: {
                  waitingOnMe: 0,
                  failedStartedByMe: 0,
                  pipelineWaitsOnMe: 0,
                  workItemsWaitingOnMe: mockBadgeCount,
                  badgeCount: mockBadgeCount,
                  waitingOnOthers: 0,
                },
                error: null,
              });
            },
          },
        },
      }),
    },
  }),
}));

const projectId = "019e9a92-b432-73e8-9341-3519156fa900";
const { ProjectTabsBar } = await import("./project-tabs-bar");

describe("ProjectTabsBar", () => {
  let dom: JSDOM;
  let originalOffsetWidth: PropertyDescriptor | undefined;
  let originalClientWidth: PropertyDescriptor | undefined;

  beforeEach(() => {
    dom = installDom({ url: "https://app.scarn.io/", pretendToBeVisual: true });

    Object.assign(globalThis, {
      location: dom.window.location,
    });

    Object.defineProperty(window, "matchMedia", {
      configurable: true,
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
      writable: true,
    });

    class MockResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}

      observe() {
        this.callback([], this);
      }

      disconnect() {}

      unobserve() {}
    }

    Object.assign(globalThis, { ResizeObserver: MockResizeObserver });

    originalOffsetWidth = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetWidth",
    );
    originalClientWidth = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientWidth",
    );

    mockPathname = "/alice/project-1/work-items";
    mockContainerWidth = 320;
    mockBadgeCount = 0;
    summaryCalls.length = 0;

    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get(this: HTMLElement) {
        const text = this.textContent.trim();
        const widths: Record<string, number> = {
          Overview: 96,
          "Work Items": 120,
          Runs: 80,
          "Pipelines & Automations": 190,
          Inbox: 90,
          Settings: 90,
          More: 84,
        };
        return widths[text] ?? 0;
      },
    });

    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) {
        if (this.dataset["testid"] === "project-tabs-bar") {
          return mockContainerWidth;
        }
        return this.offsetWidth;
      },
    });
  });

  afterEach(() => {
    cleanup();

    if (originalOffsetWidth) {
      Object.defineProperty(
        HTMLElement.prototype,
        "offsetWidth",
        originalOffsetWidth,
      );
    }
    if (originalClientWidth) {
      Object.defineProperty(
        HTMLElement.prototype,
        "clientWidth",
        originalClientWidth,
      );
    }
  });

  const renderTabsBar = (
    isMember?: boolean,
    isDemoProject?: boolean,
    withProjectId = false,
  ) =>
    render(
      <ProjectTabsBar
        username="alice"
        projectSlug="project-1"
        projectName="Project One"
        orgId="org-1"
        {...(withProjectId ? { projectId } : {})}
        {...(isMember === undefined ? {} : { isMember })}
        {...(isDemoProject === undefined ? {} : { isDemoProject })}
      />,
    );

  test("moves overflowed project tabs into the More menu on narrow widths", async () => {
    const view = renderTabsBar();

    expect(view.getByRole("tab", { name: "Work Items" })).toBeTruthy();
    expect(view.getByRole("tab", { name: "Runs" })).toBeTruthy();
    expect(
      view.queryByRole("tab", { name: "Pipelines & Automations" }),
    ).toBeNull();

    fireEvent.click(view.getByRole("tab", { name: "More project tabs" }));

    expect(
      await within(document.body).findByRole("menuitem", {
        name: "Pipelines & Automations",
      }),
    ).toBeTruthy();
    expect(
      within(document.body).getByRole("menuitem", { name: "Inbox" }),
    ).toBeTruthy();
    expect(
      within(document.body).getByRole("menuitem", { name: "Settings" }),
    ).toBeTruthy();
  });

  test("drops the Overview tab for a non-demo project, even when everything fits", () => {
    mockContainerWidth = 1200;

    const view = renderTabsBar();

    // Compared by href rather than label: emotion injects its <style> tag into
    // the first rendered tab, which pollutes `textContent`.
    expect(
      view.getAllByRole("tab").map((tab) => tab.getAttribute("href")),
    ).toEqual([
      "/alice/project-1/work-items",
      "/alice/project-1/runs",
      "/alice/project-1/pipelines",
      "/alice/project-1/inbox",
      "/alice/project-1/settings",
    ]);
    expect(view.queryByRole("tab", { name: "Overview" })).toBeNull();
    expect(view.queryByRole("tab", { name: "More project tabs" })).toBeNull();
  });

  test("shows all six member tabs, Overview first, on the demo project", () => {
    mockContainerWidth = 1200;

    const view = renderTabsBar(true, true);

    expect(
      view.getAllByRole("tab").map((tab) => tab.getAttribute("href")),
    ).toEqual([
      "/alice/project-1/tour",
      "/alice/project-1/work-items",
      "/alice/project-1/runs",
      "/alice/project-1/pipelines",
      "/alice/project-1/inbox",
      "/alice/project-1/settings",
    ]);
    expect(view.queryByRole("tab", { name: "More project tabs" })).toBeNull();
  });

  test("has no Executions, Tasks, or Conversations tabs", () => {
    mockContainerWidth = 1200;

    const view = renderTabsBar(true, true);

    expect(view.queryByRole("tab", { name: "Executions" })).toBeNull();
    expect(view.queryByRole("tab", { name: "Tasks" })).toBeNull();
    expect(view.queryByRole("tab", { name: "Conversations" })).toBeNull();
  });

  test("links the Runs tab to the project's runs page", () => {
    mockContainerWidth = 1200;

    const view = renderTabsBar(true);

    expect(view.getByRole("tab", { name: "Runs" }).getAttribute("href")).toBe(
      "/alice/project-1/runs",
    );
  });

  for (const pathname of [
    "/alice/project-1/runs",
    "/alice/project-1/runs/exec-1",
    "/alice/project-1/runs/tasks/task-1",
    "/alice/project-1/runs/chats/chat-1",
  ]) {
    test(`marks Runs active on ${pathname}`, () => {
      mockContainerWidth = 1200;
      mockPathname = pathname;

      const view = renderTabsBar(false);

      expect(
        view.getByRole("tab", { name: "Runs" }).getAttribute("aria-selected"),
      ).toBe("true");
    });
  }

  test("labels the pipelines tab Pipelines & Automations and links it to the pipelines page for a member", () => {
    mockContainerWidth = 1200;

    const view = renderTabsBar(true);

    expect(
      view
        .getByRole("tab", { name: "Pipelines & Automations" })
        .getAttribute("href"),
    ).toBe("/alice/project-1/pipelines");
  });

  test("shows only Work Items and Runs for a non-member viewer of a non-demo project", () => {
    mockContainerWidth = 900;

    const view = renderTabsBar(false);

    expect(
      view.getAllByRole("tab").map((tab) => tab.getAttribute("href")),
    ).toEqual(["/alice/project-1/work-items", "/alice/project-1/runs"]);
    expect(view.queryByRole("tab", { name: "More project tabs" })).toBeNull();
  });

  test("shows Overview, Work Items, and Runs for a non-member viewer of the demo project", () => {
    mockContainerWidth = 900;

    const view = renderTabsBar(false, true);

    expect(
      view.getAllByRole("tab").map((tab) => tab.getAttribute("href")),
    ).toEqual([
      "/alice/project-1/tour",
      "/alice/project-1/work-items",
      "/alice/project-1/runs",
    ]);
  });

  test("overflows the non-member demo tab set into the More menu when it doesn't fit", async () => {
    mockContainerWidth = 250;

    const view = renderTabsBar(false, true);

    expect(view.getByRole("tab", { name: "Overview" })).toBeTruthy();
    expect(view.queryByRole("tab", { name: "Runs" })).toBeNull();

    fireEvent.click(view.getByRole("tab", { name: "More project tabs" }));

    expect(
      await within(document.body).findByRole("menuitem", {
        name: "Runs",
      }),
    ).toBeTruthy();
  });

  test("links the Overview tab at the /tour segment", () => {
    mockContainerWidth = 1200;

    const view = renderTabsBar(true, true);

    expect(
      view.getByRole("tab", { name: "Overview" }).getAttribute("href"),
    ).toBe("/alice/project-1/tour");
    expect(
      view.getByRole("tab", { name: "Work Items" }).getAttribute("href"),
    ).toBe("/alice/project-1/work-items");
  });

  test("marks Overview active on /tour", () => {
    mockContainerWidth = 1200;
    mockPathname = "/alice/project-1/tour";

    const view = renderTabsBar(true, true);
    expect(
      view.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  test("does not mark Overview active on a sub-route of the project", () => {
    mockContainerWidth = 1200;
    mockPathname = "/alice/project-1/work-items/abc";

    const view = renderTabsBar(true, true);

    expect(
      view.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected"),
    ).toBe("false");
    expect(
      view
        .getByRole("tab", { name: "Work Items" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  test("shows the inbox badge count on the Inbox tab, work items waiting on the viewer included", async () => {
    mockContainerWidth = 1200;
    mockBadgeCount = 3;

    const view = renderTabsBar(true, false, true);

    const inboxTab = view.getByRole("tab", { name: /Inbox/ });
    expect(
      (await within(inboxTab).findByTestId("inbox-badge")).textContent,
    ).toBe("3");
    expect(summaryCalls).toEqual([projectId]);
  });

  test("hides the inbox badge at 0", async () => {
    mockContainerWidth = 1200;

    const view = renderTabsBar(true, false, true);

    await waitFor(() => {
      expect(summaryCalls).toEqual([projectId]);
    });
    expect(view.queryByTestId("inbox-badge")).toBeNull();
  });

  test("never reads the inbox summary for a non-member", async () => {
    mockContainerWidth = 1200;
    mockBadgeCount = 3;

    const view = renderTabsBar(false, false, true);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(summaryCalls).toEqual([]);
    expect(view.queryByTestId("inbox-badge")).toBeNull();
  });
});

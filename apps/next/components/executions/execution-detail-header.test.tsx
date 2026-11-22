import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import type { ProjectRun } from "@/components/runs/runs-api";
import { buildRun, viewerId } from "@/components/runs/runs-list-fixtures";
import { installDom } from "@/tests/support/install-dom";

let currentSearch = "";
void mock.module("next/navigation", () => ({
  useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
  usePathname: () => "/tester/demo/runs/x",
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

const dom = installDom();
Object.assign(globalThis, {
  HTMLAnchorElement: dom.window.HTMLAnchorElement,
  HTMLButtonElement: dom.window.HTMLButtonElement,
  sessionStorage: dom.window.sessionStorage,
});

const { cleanup, fireEvent, render, within } =
  await import("@testing-library/react");
const { ExecutionDetailHeader } = await import("./execution-detail-header");
const { ProjectRouteProvider } =
  await import("@/components/project-route-context");

const PROJECT_ID = "01966a2c-9494-7db5-aa46-0f8f5cbbe001";
const onRerun = mock(() => {});
const onToggleDetails = mock(() => {});

const inRoute = (children: ReactNode) => (
  <ProjectRouteProvider
    username="tester"
    projectSlug="demo"
    projectId={PROJECT_ID}
    isMember
    permissions={[]}
  >
    {children}
  </ProjectRouteProvider>
);

const renderHeader = (
  props: Partial<Parameters<typeof ExecutionDetailHeader>[0]> & {
    run?: ProjectRun | null;
  } = {},
) =>
  render(
    inRoute(
      <ExecutionDetailHeader
        run={buildRun({ workItem: null, status: "failed" })}
        viewerUserId={viewerId}
        fallbackTitle="Quality Gate"
        onRerun={onRerun}
        rerunDisabled={false}
        pendingActionLabel=""
        detailsOpen={false}
        onToggleDetails={onToggleDetails}
        {...props}
      />,
    ),
  );

describe("ExecutionDetailHeader", () => {
  beforeEach(() => {
    onRerun.mockClear();
    onToggleDetails.mockClear();
    currentSearch = "";
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
  });

  afterEach(() => {
    cleanup();
  });

  test("is the shared run header: title, status and the run's shape", () => {
    const view = renderHeader({ stepsSoFar: 3, placesAtOnce: 2 });

    expect(view.getByRole("heading", { level: 1 }).textContent).toBe(
      "Fix the login bug",
    );
    expect(view.getByText("Failed")).toBeTruthy();
    expect(view.getByTestId("run-header-caption").textContent).toContain(
      "3 steps so far · in 2 places at once",
    );
    expect(
      view.getByRole("link", { name: /^← Runs/ }).getAttribute("href"),
    ).toBe("/tester/demo/runs");
  });

  test("back goes to the work item named by ?from=", () => {
    currentSearch = "from=work-item:01966a2c-9494-7db5-aa46-0f8f5cbbe601";
    const view = renderHeader();

    expect(
      view.getByRole("link", { name: "← Work item" }).getAttribute("href"),
    ).toBe("/tester/demo/work-items/01966a2c-9494-7db5-aa46-0f8f5cbbe601");
  });

  test("shows the fallback title with the actions until the row loads", () => {
    const view = renderHeader({ run: null });

    expect(view.getByRole("heading", { level: 1 }).textContent).toBe(
      "Quality Gate",
    );
    expect(
      view.getByRole("button", { name: "Re-run from start" }),
    ).toBeTruthy();
  });

  test("Re-run from start reruns, and Details toggles the drawer", () => {
    const view = renderHeader({ detailsOpen: true });

    fireEvent.click(view.getByRole("button", { name: "Re-run from start" }));
    expect(onRerun).toHaveBeenCalledTimes(1);

    const details = view.getByRole("button", { name: "Details" });
    expect(details.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(details);
    expect(onToggleDetails).toHaveBeenCalledTimes(1);
  });

  test("hides the rerun control for a non-member viewer (canRerun=false)", () => {
    const view = renderHeader({ canRerun: false });

    expect(
      view.queryByRole("button", { name: "Re-run from start" }),
    ).toBeNull();
    expect(view.getByRole("button", { name: "Details" })).toBeTruthy();
  });

  test("hides the rerun control when the run has no visit to rerun", () => {
    const view = renderHeader({ onRerun: null });

    expect(
      view.queryByRole("button", { name: "Re-run from start" }),
    ).toBeNull();
  });

  test("with a step selected, adds the step bar and the ⋯ menu", async () => {
    const onViewChange = mock(() => {});
    const onStepRerun = mock(() => {});

    const view = renderHeader({
      step: {
        name: "quality-gate",
        status: "abandoned",
        view: "conversation",
        onViewChange,
        onRerun: onStepRerun,
      },
    });

    expect(
      view.getByRole("heading", { level: 2, name: "quality-gate" }),
    ).toBeTruthy();
    expect(view.getByText("· Abandoned")).toBeTruthy();

    fireEvent.click(view.getByRole("tab", { name: "Logs" }));
    expect(onViewChange).toHaveBeenCalledWith("logs");

    fireEvent.click(view.getByRole("button", { name: "Run actions" }));
    const menu = await within(document.body).findByRole("menu");
    fireEvent.click(within(menu).getByText("Rerun from this step"));
    expect(onStepRerun).toHaveBeenCalledTimes(1);
    expect(onRerun).not.toHaveBeenCalled();
  });
});

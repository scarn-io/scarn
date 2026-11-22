import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import type { JSDOM } from "jsdom";
// Type-only, so the server-only module it names (which imports `next/headers`)
// is erased and never actually loaded here.
import type {
  OverviewRunHighlight,
  ProjectOverviewCounts,
  ProjectOverviewTour,
} from "@/app/(protected)/projects/_lib/project-overview-server";
// Deliberately no `mock.module("next/navigation", …)`: both components are
// server-renderable and reach for nothing but `next/link`. `mock.module` is
// process-global, so a mock here would fight `project-tabs-bar.test.tsx`'s when
// bun runs both files in one process.
import { ProjectOverviewGuestTour } from "./project-overview-guest-tour";
import { ProjectOverviewMemberSummary } from "./project-overview-member-summary";
import { installDom } from "@/tests/support/install-dom";

const succeededHighlight: OverviewRunHighlight = {
  executionId: "019e709b-574f-742c-8fda-00a1bcc71b02",
  workItemId: "019e709b-574f-742c-8fda-00a1bcc71b01",
  workItemTitle: "Checkout crashes when applying a coupon",
  nodeId: "reproduce",
};

const runningHighlight: OverviewRunHighlight = {
  executionId: "019e709b-574f-742c-8fda-00a1bcc71b12",
  workItemId: "019e709b-574f-742c-8fda-00a1bcc71b11",
  workItemTitle: "Search returns stale results after a sync",
  nodeId: "evaluate",
};

const fullTour: ProjectOverviewTour = {
  transcript: succeededHighlight,
  trace: succeededHighlight,
  inProgress: runningHighlight,
};

const emptyTour: ProjectOverviewTour = {
  transcript: null,
  trace: null,
  inProgress: null,
};

const counts: ProjectOverviewCounts = {
  workItems: 11,
  executions: 7,
  runningExecutions: 2,
  succeededExecutions: 4,
  pipelines: 3,
  integrations: [],
  hasEnabledProjectAutomation: true,
};

const renderTour = (tour: ProjectOverviewTour) =>
  render(
    <ProjectOverviewGuestTour username="demo" projectSlug="demo" tour={tour} />,
  );

/**
 * The href of the link wrapping `matcher`'s text — both components make the
 * whole card/tile one anchor.
 *
 * Text-then-`closest` rather than `getByRole("link", { name })`: computing an
 * accessible name calls `getComputedStyle`, and jsdom 29 throws on emotion's
 * `border` shorthand rules once another test file in the same bun process has
 * already primed the emotion cache.
 */
const hrefOf = (
  view: ReturnType<typeof render>,
  matcher: RegExp | string,
): string | null =>
  view.getByText(matcher).closest("a")?.getAttribute("href") ?? null;

describe("project Overview", () => {
  let dom: JSDOM;

  beforeEach(() => {
    dom = installDom({ url: "https://app.scarn.io/demo/demo" });

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
  });

  afterEach(() => {
    cleanup();
  });

  describe("ProjectOverviewGuestTour", () => {
    test("deep-links the transcript card into the step's conversation", () => {
      const view = renderTour(fullTour);

      expect(hrefOf(view, /Checkout crashes when applying a coupon/)).toBe(
        "/demo/demo/runs/019e709b-574f-742c-8fda-00a1bcc71b02?step=reproduce",
      );
    });

    test("links the trace card at the step holding the trace, scrolled to Artifacts", () => {
      const view = renderTour(fullTour);

      expect(hrefOf(view, /drive a real browser/)).toBe(
        "/demo/demo/runs/019e709b-574f-742c-8fda-00a1bcc71b02?step=reproduce&focus=artifacts",
      );
    });

    test("links the in-progress card into the conversation of the step the run is on", () => {
      const view = renderTour(fullTour);

      expect(hrefOf(view, /Search returns stale results after a sync/)).toBe(
        "/demo/demo/runs/019e709b-574f-742c-8fda-00a1bcc71b12?step=evaluate",
      );
      expect(view.getByText(/Running right now/i)).toBeTruthy();
    });

    test("omits the trace card when no step recorded a trace", () => {
      const view = renderTour({ ...fullTour, trace: null });

      expect(view.queryByText(/Playwright trace/i)).toBeNull();
      expect(hrefOf(view, /Checkout crashes when applying a coupon/)).toBe(
        "/demo/demo/runs/019e709b-574f-742c-8fda-00a1bcc71b02?step=reproduce",
      );
    });

    test("omits the in-progress card when nothing is running", () => {
      const view = renderTour({ ...fullTour, inProgress: null });

      expect(view.queryByText(/Running right now/i)).toBeNull();
      expect(
        view.queryByText(/Search returns stale results after a sync/),
      ).toBeNull();
    });

    test("falls back to the run itself when no step could be resolved", () => {
      const view = renderTour({
        transcript: { ...succeededHighlight, nodeId: null },
        trace: null,
        inProgress: null,
      });

      expect(hrefOf(view, /Checkout crashes when applying a coupon/)).toBe(
        "/demo/demo/runs/019e709b-574f-742c-8fda-00a1bcc71b02",
      );
    });

    test("renders an empty state and the work items link for a project with no runs", () => {
      const view = renderTour(emptyTour);

      expect(view.getByText(/no agent runs to show yet/i)).toBeTruthy();
      expect(hrefOf(view, /Browse every work item/)).toBe(
        "/demo/demo/work-items",
      );
      // The browse link is the only link left: no card was rendered
      // speculatively for a target the project doesn't have.
      expect(view.container.querySelectorAll("a")).toHaveLength(1);
    });
  });

  describe("ProjectOverviewMemberSummary", () => {
    const renderSummary = (summaryCounts: ProjectOverviewCounts) =>
      render(
        <ProjectOverviewMemberSummary
          username="alice"
          projectSlug="project-1"
          counts={summaryCounts}
        />,
      );

    test("renders each count linked to the tab that owns it", () => {
      const view = renderSummary(counts);

      expect(hrefOf(view, "Work items")).toBe("/alice/project-1/work-items");
      expect(hrefOf(view, "Pipelines")).toBe("/alice/project-1/pipelines");
      expect(hrefOf(view, "Runs")).toBe("/alice/project-1/runs?status=all");
      expect(hrefOf(view, "Running now")).toBe(
        "/alice/project-1/runs?status=running",
      );
      expect(view.getByText("11")).toBeTruthy();
      expect(view.getByText("3")).toBeTruthy();
      expect(view.getByText("7")).toBeTruthy();
      expect(view.getByText("2")).toBeTruthy();
    });

    test("singularizes the labels for a one-of-each project", () => {
      const view = renderSummary({
        ...counts,
        workItems: 1,
        executions: 1,
        runningExecutions: 0,
        pipelines: 1,
      });

      expect(view.getByText("Work item")).toBeTruthy();
      expect(view.getByText("Pipeline")).toBeTruthy();
      expect(view.getByText("Run")).toBeTruthy();
    });
  });
});

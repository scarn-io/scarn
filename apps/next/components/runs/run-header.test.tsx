/**
 * A run's page header reads its Runs-list row: breadcrumb, status pill and
 * outcome, and a caption that shows only what it knows. The frame drops the
 * header when the id is not a row.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  projectId,
  withProjectRoute,
} from "@/components/tasks/tasks-test-support";
import type { ProjectRun } from "./runs-api";
import { buildRun, id, itemId, viewerId } from "./runs-list-fixtures";

const state = {
  search: "",
  run: null as ProjectRun | null,
  status: 200,
  lookups: [] as string[],
};

void mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => "/alice/demo/runs/tasks/x",
  useSearchParams: () => new URLSearchParams(state.search),
  notFound: () => {
    throw new Error("notFound");
  },
}));

void mock.module("@/app/_lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: { user: { id: viewerId } } }) },
}));

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      projects: () => ({
        runs:
          ({ type }: { type: string }) =>
          ({ id: runId }: { id: string }) => ({
            get: () => {
              state.lookups.push(`${type}:${runId}`);
              return Promise.resolve(
                state.status === 200
                  ? { data: state.run, error: null }
                  : {
                      data: null,
                      error: { value: { status: state.status } },
                    },
              );
            },
          }),
      }),
    },
  }),
}));

const { cleanup, render, waitFor, within } =
  await import("@testing-library/react");
const { RunHeader, updatedText } = await import("./run-header");
const { RunFrame } = await import("./run-frame");
const { rememberRunsQuery } = await import("./runs-back-target");

const parentId = id("701");
const page = () => within(document.body);

const renderHeader = async (
  run: ProjectRun | null,
  extra: { stepsSoFar?: number; placesAtOnce?: number } = {},
) =>
  render(
    await withProjectRoute(
      <RunHeader run={run} viewerUserId={viewerId} {...extra} />,
    ),
  );

const caption = () => page().getByTestId("run-header-caption").textContent;
const backLink = () => page().getByRole("link", { name: /^← / });

describe("RunHeader", () => {
  beforeEach(() => {
    state.search = "";
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  test("breadcrumb names what ran with its kind", async () => {
    await renderHeader(buildRun());
    const crumbs = within(page().getByRole("navigation"));
    expect(crumbs.getByTestId("run-header-what-ran").textContent).toBe(
      "Ship it",
    );
    expect(crumbs.getByTitle("Pipeline run")).toBeTruthy();
  });

  test("the title carries the status pill and the outcome", async () => {
    await renderHeader(
      buildRun({ status: "ended", outcome: "Rejected by review" }),
    );
    expect(page().getByRole("heading").textContent).toBe("Fix the login bug");
    expect(page().getByText("Ended").getAttribute("data-status")).toBe("ended");
    expect(page().getByText("Rejected by review")).toBeTruthy();
  });

  test("no outcome chip without an outcome", async () => {
    await renderHeader(buildRun({ status: "running" }));
    expect(page().getByText("Running")).toBeTruthy();
    expect(page().queryByTitle("What went wrong")).toBeNull();
  });

  test("caption: parent › key, started by you, updated", async () => {
    await renderHeader(
      buildRun({
        workItem: {
          id: itemId,
          platformKey: "GH-12",
          title: "Fix the login bug",
          parent: { id: parentId, platformKey: "GH-1", title: "Auth" },
        },
        updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      }),
    );
    expect(caption()).toBe("GH-1 › GH-12 · started by you · updated 5m ago");
    expect(
      page().getByRole("link", { name: "GH-1" }).getAttribute("href"),
    ).toBe(`/alice/demo/work-items/${parentId}`);
    expect(
      page().getByRole("link", { name: "GH-12" }).getAttribute("href"),
    ).toBe(`/alice/demo/work-items/${itemId}`);
  });

  test("caption names an automation, and leaves out a missing work item", async () => {
    await renderHeader(
      buildRun({
        type: "task",
        whatRan: { kind: "task", name: "Task" },
        workItem: null,
        startedBy: {
          kind: "automation",
          automationId: id("650"),
          key: "triage",
          title: "Triage new issues",
        },
      }),
    );
    expect(caption()).toBe("started by Triage new issues · updated just now");
  });

  test("pipeline parts show only when given", async () => {
    await renderHeader(buildRun({ workItem: null }), {
      stepsSoFar: 4,
      placesAtOnce: 2,
    });
    expect(caption()).toBe(
      "4 steps so far · in 2 places at once · started by you · updated just now",
    );
    cleanup();
    await renderHeader(buildRun({ workItem: null }), {
      stepsSoFar: 1,
      placesAtOnce: 1,
    });
    expect(caption()).toBe("1 step so far · started by you · updated just now");
  });

  test("back goes to the Runs list with its last query", async () => {
    await renderHeader(buildRun());
    expect(backLink().getAttribute("href")).toBe("/alice/demo/runs");
    cleanup();
    rememberRunsQuery(projectId, "status=finished&q=login");
    await renderHeader(buildRun());
    await waitFor(() => {
      expect(backLink().getAttribute("href")).toBe(
        "/alice/demo/runs?status=finished&q=login",
      );
    });
  });

  test("an explicit from wins over the last query", async () => {
    rememberRunsQuery(projectId, "status=finished");
    state.search = `from=work-item:${itemId}`;
    await renderHeader(buildRun());
    expect(backLink().getAttribute("href")).toBe(
      `/alice/demo/work-items/${itemId}`,
    );
    expect(backLink().textContent).toBe("← Work item");
  });

  test("an unrecognised from falls back to the Runs list", async () => {
    state.search = "from=somewhere";
    await renderHeader(buildRun());
    expect(backLink().getAttribute("href")).toBe("/alice/demo/runs");
  });

  test("while loading, only the back crumb shows", async () => {
    await renderHeader(null);
    expect(backLink()).toBeTruthy();
    expect(page().queryByRole("heading")).toBeNull();
  });

  test("updatedText", () => {
    const now = Date.parse("2026-06-24T12:00:00Z");
    expect(updatedText("2026-06-24T11:59:30Z", now)).toBe("updated just now");
    expect(updatedText("2026-06-24T09:00:00Z", now)).toBe("updated 3h ago");
    expect(updatedText("2026-05-01T12:00:00Z", now)).toBe("updated May 1");
  });
});

describe("RunFrame", () => {
  beforeEach(() => {
    state.search = "";
    state.status = 200;
    state.lookups = [];
    state.run = buildRun({
      type: "step",
      id: id("520"),
      href: `runs/tasks/${id("520")}`,
      whatRan: { kind: "step", id: id("610"), name: "Build" },
      status: "needs-you",
    });
  });

  afterEach(() => {
    cleanup();
  });

  const renderFrame = async () =>
    render(
      await withProjectRoute(
        <RunFrame
          projectId={projectId}
          lookup={{ type: "task", id: id("520") }}
          layout="scroll"
          pollIntervalMs={60_000}
        >
          {({ framed }) => (
            <div data-testid="pane">{framed ? "framed" : "own header"}</div>
          )}
        </RunFrame>,
      ),
    );

  test("reads the row and shows it over a framed pane", async () => {
    await renderFrame();
    await waitFor(() => {
      expect(page().getByRole("heading").textContent).toBe("Fix the login bug");
    });
    expect(state.lookups[0]).toBe(`task:${id("520")}`);
    expect(page().getByText("Needs you")).toBeTruthy();
    expect(page().getByTestId("pane").textContent).toBe("framed");
  });

  test("a Task that is not a row keeps its own header", async () => {
    state.status = 404;
    await renderFrame();
    await waitFor(() => {
      expect(page().getByTestId("pane").textContent).toBe("own header");
    });
    expect(page().queryByTestId("run-header")).toBeNull();
  });

  test("a failed read warns and keeps the pane framed", async () => {
    state.status = 500;
    await renderFrame();
    await waitFor(() => {
      expect(page().getByText("Could not load this run.")).toBeTruthy();
    });
    expect(page().getByTestId("run-header")).toBeTruthy();
    expect(page().getByTestId("pane").textContent).toBe("framed");
  });
});

/**
 * A Runs row: columns at `lg` with a meta line below it, the What ran
 * column dropped when scoped, parent keys, and "you" against automations.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import { withProjectRoute } from "@/components/tasks/tasks-test-support";
import type { ProjectRun } from "./runs-api";

const { cleanup, render, within } = await import("@testing-library/react");
const { ColumnHeader, RunRow } = await import("./run-row");
const { compactAge, runStatusText } = await import("./run-row-parts");

const id = (suffix: string) =>
  parseUuidV7(`019e9a92-b432-73e8-9341-3519156fa${suffix}`);
const viewerId = id("900");
const itemId = id("700");
const parentId = id("701");
const runId = id("500");

const buildRun = (overrides: Partial<ProjectRun> = {}): ProjectRun => ({
  type: "pipeline",
  id: runId,
  href: `runs/${runId}`,
  title: "Fix the login bug",
  whatRan: { kind: "pipeline", id: id("600"), name: "Ship it" },
  workItem: {
    id: itemId,
    platformKey: "GH-12",
    title: "Fix the login bug",
    parent: null,
  },
  status: "running",
  statusLine: "running implement",
  outcome: null,
  openNodeIds: ["implement"],
  waitingOnYou: false,
  waitingOn: [],
  startedBy: { kind: "user", userId: viewerId, username: "alice" },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});

const renderRow = async (
  run: ProjectRun,
  whatRan = true,
  viewerUserId: string | null = viewerId,
) =>
  render(
    await withProjectRoute(
      <>
        <ColumnHeader columns={{ whatRan }} />
        <RunRow run={run} columns={{ whatRan }} viewerUserId={viewerUserId} />
      </>,
    ),
  );

/** Every CSS rule emotion wrote for `element`'s generated class. */
const cssFor = (element: Element): string => {
  const className = [...element.classList].find((name) =>
    /^css-[\w-]+$/.test(name),
  );
  if (!className) return "";
  return [...document.styleSheets]
    .flatMap((sheet) => [...sheet.cssRules])
    .map((rule) => rule.cssText.replace(/\s*([:;{}])\s*/g, "$1"))
    .filter((text) => text.includes(`.${className}`))
    .join("\n");
};

describe("RunRow", () => {
  beforeAll(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
  });

  afterEach(() => {
    cleanup();
  });

  test("the whole row links to the run, and the work item key to the item", async () => {
    const view = await renderRow(buildRun());
    const row = view.getByTestId("run-row");
    expect(
      within(row)
        .getByRole("link", { name: "Fix the login bug" })
        .getAttribute("href"),
    ).toBe(`/alice/demo/runs/${runId}`);
    const keys = within(row).getAllByRole("link", { name: "GH-12" });
    expect(keys.length).toBe(2);
    for (const key of keys) {
      expect(key.getAttribute("href")).toBe(`/alice/demo/work-items/${itemId}`);
    }
  });

  test("columns show at lg; the meta line shows below it", async () => {
    const view = await renderRow(buildRun());
    const row = view.getByTestId("run-row");
    const cell = row.querySelector('[data-column="work-item"]');
    const meta = view.getByTestId("run-row-meta");
    const header = view.getByTestId("runs-column-header");
    expect(cell).not.toBeNull();
    expect(cssFor(cell as Element)).toMatch(
      /display:none;[\s\S]*@media \(min-width:1200px\)[\s\S]*display:block/,
    );
    expect(cssFor(meta)).toMatch(
      /display:block;[\s\S]*@media \(min-width:1200px\)[\s\S]*display:none/,
    );
    expect(cssFor(header)).toMatch(
      /display:none;[\s\S]*@media \(min-width:1200px\)[\s\S]*display:grid/,
    );
    expect(cssFor(row)).toContain(
      "grid-template-columns:20px minmax(0, 1fr) 48px",
    );
    expect(cssFor(row)).toContain(
      "grid-template-columns:20px minmax(0, 1fr) 140px 104px 104px 48px",
    );
  });

  test("drops the What ran column and meta prefix when scoped to one pipeline", async () => {
    const scoped = await renderRow(buildRun(), false);
    const row = scoped.getByTestId("run-row");
    expect(row.querySelector('[data-column="what-ran"]')).toBeNull();
    expect(
      within(scoped.getByTestId("runs-column-header")).queryByText("What ran"),
    ).toBeNull();
    expect(scoped.getByTestId("run-row-meta").textContent).not.toContain(
      "Ship it",
    );
    expect(cssFor(row)).toContain(
      "grid-template-columns:20px minmax(0, 1fr) 104px 104px 48px",
    );
    cleanup();

    const all = await renderRow(buildRun(), true);
    expect(
      all.getByTestId("run-row").querySelector('[data-column="what-ran"]')
        ?.textContent,
    ).toBe("Ship it");
    expect(all.getByTestId("run-row-meta").textContent).toContain("Ship it · ");
  });

  test("a child item shows its parent's key, linked", async () => {
    const view = await renderRow(
      buildRun({
        workItem: {
          id: itemId,
          platformKey: "GH-13",
          title: "Child",
          parent: { id: parentId, platformKey: "GH-1", title: "Epic" },
        },
      }),
    );
    const cell = view
      .getByTestId("run-row")
      .querySelector('[data-column="work-item"]') as HTMLElement;
    expect(cell.textContent).toBe("GH-13in GH-1");
    expect(view.getByTestId("run-row-meta").textContent).toContain(
      "GH-13 in GH-1",
    );
    expect(
      within(cell).getByRole("link", { name: "GH-1" }).getAttribute("href"),
    ).toBe(`/alice/demo/work-items/${parentId}`);
  });

  test("the viewer's own runs read 'you'; automations and others by name", async () => {
    const mine = await renderRow(buildRun());
    expect(
      mine.getByTestId("run-row").querySelector('[data-column="started-by"]')
        ?.textContent,
    ).toBe("you");
    cleanup();

    const automated = await renderRow(
      buildRun({
        startedBy: {
          kind: "automation",
          automationId: id("800"),
          key: "nightly",
          title: "Nightly triage",
        },
      }),
    );
    expect(
      automated
        .getByTestId("run-row")
        .querySelector('[data-column="started-by"]')?.textContent,
    ).toBe("Nightly triage");
    expect(automated.getByTestId("run-row-meta").textContent).toContain(
      "Nightly triage",
    );
    cleanup();

    const guest = await renderRow(buildRun(), true, null);
    expect(
      guest.getByTestId("run-row").querySelector('[data-column="started-by"]')
        ?.textContent,
    ).toBe("alice");
  });

  test("a Task without a work item leaves the column empty", async () => {
    const view = await renderRow(
      buildRun({
        type: "task",
        href: `runs/tasks/${runId}`,
        whatRan: { kind: "task", name: "Task" },
        workItem: null,
      }),
    );
    expect(
      view
        .getByRole("link", { name: "Fix the login bug" })
        .getAttribute("href"),
    ).toBe(`/alice/demo/runs/tasks/${runId}`);
    expect(
      view.getByTestId("run-row").querySelector('[data-column="work-item"]')
        ?.textContent,
    ).toBe("—");
  });

  test("status mark is filled for needs-you, failed and ended only; outcome shows", async () => {
    const view = await renderRow(
      buildRun({
        status: "ended",
        outcome: "rejected",
        statusLine: "Rejected",
      }),
    );
    const mark = view.getByRole("img", { name: "Ended" });
    expect(mark.getAttribute("data-loud")).toBe("true");
    expect(view.getByText("rejected")).toBeTruthy();
    cleanup();

    const waiting = await renderRow(buildRun({ status: "waiting" }));
    expect(
      waiting.getByRole("img", { name: "Waiting" }).getAttribute("data-loud"),
    ).toBe("false");
  });
});

describe("runStatusText", () => {
  test("names who a run waits on", () => {
    const run = buildRun({
      status: "waiting",
      statusLine: "Waiting for a reply at review",
      waitingOn: [{ userId: id("901"), username: "bob" }],
    });
    expect(runStatusText(run)).toBe("Waiting on bob");
    expect(
      runStatusText({ ...run, statusLine: "Which database should I use?" }),
    ).toBe("Waiting on bob · Which database should I use?");
  });
});

describe("compactAge", () => {
  test("fits the Updated column", () => {
    const now = Date.parse("2026-11-12T12:00:00Z");
    expect(compactAge("2026-11-12T11:59:30Z", now)).toBe("now");
    expect(compactAge("2026-11-12T11:55:00Z", now)).toBe("5m");
    expect(compactAge("2026-11-12T09:00:00Z", now)).toBe("3h");
    expect(compactAge("2026-11-10T12:00:00Z", now)).toBe("2d");
    expect(compactAge("2026-10-01T12:00:00Z", now)).toBe("Oct 1");
  });
});

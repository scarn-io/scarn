/**
 * The Runs page body: the URL becomes the API query, tabs show the counts,
 * narrowed deep links show removable chips, the sidebar lists the facets,
 * and empty lists say why.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { withProjectRoute } from "@/components/tasks/tasks-test-support";
import type { ProjectRun, RunsCounts } from "./runs-api";
import {
  automationId,
  buildCounts,
  buildRun,
  id,
  itemId,
  pipelineId,
  viewerId,
} from "./runs-list-fixtures";

const state = {
  search: "",
  requests: [] as Record<string, unknown>[],
  runs: [] as ProjectRun[],
  counts: null as RunsCounts | null,
  replaced: [] as string[],
  pushed: [] as string[],
  chatBodies: [] as string[],
  createdTaskId: undefined as string | undefined,
  batchCancels: [] as string[][],
  taskCancels: [] as string[],
};

void mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string) => {
      state.pushed.push(href);
    },
    replace: (href: string) => {
      state.replaced.push(href);
    },
    refresh: () => {},
  }),
  usePathname: () => "/alice/demo/runs",
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
      "pipeline-executions": {
        batch: {
          cancel: {
            put: ({ input }: { input: string[] }) => {
              state.batchCancels.push(input);
              return Promise.resolve({
                data: { cancelledIds: input, skippedIds: [] },
                error: null,
              });
            },
          },
        },
      },
      tasks: ({ taskId }: { taskId: string }) => ({
        cancel: {
          post: () => {
            state.taskCancels.push(taskId);
            return Promise.resolve({ data: { taskId }, error: null });
          },
        },
      }),
      projects: () => ({
        runs: {
          get: ({ query }: { query: Record<string, unknown> }) => {
            state.requests.push(query);
            return Promise.resolve({
              data: {
                runs: state.runs,
                nextCursor: null,
                counts: state.counts,
              },
              error: null,
            });
          },
        },
        automations: {
          get: () =>
            Promise.resolve({
              data: [
                {
                  id: automationId,
                  key: "triage",
                  title: "Triage new issues",
                  scope: "project",
                },
              ],
              error: null,
            }),
        },
        conversations: {
          post: ({ body }: { body: string }) => {
            state.chatBodies.push(body);
            return Promise.resolve({
              data: { id: id("800"), taskId: state.createdTaskId },
              error: null,
            });
          },
        },
      }),
    },
  }),
}));

const { act, cleanup, fireEvent, render, waitFor, within } =
  await import("@testing-library/react");
const { RunsList } = await import("./runs-list");

const renderList = async (
  search: string,
  isMember = true,
  permissions: string[] = [],
) => {
  state.search = search;
  const view = render(
    await withProjectRoute(
      <RunsList projectId={id("100")} />,
      permissions,
      isMember,
    ),
  );
  await waitFor(() => {
    expect(page().queryByLabelText("Loading runs")).toBeNull();
  });
  return view;
};

/** Queries `document.body` as it is now; other runs tests swap the DOM. */
const page = () => within(document.body);
const sidebar = () => within(page().getByRole("navigation"));
const columnHeader = () => within(page().getByTestId("runs-column-header"));

describe("RunsList", () => {
  beforeEach(() => {
    state.requests = [];
    state.runs = [buildRun()];
    state.counts = buildCounts();
    state.replaced = [];
    state.pushed = [];
    state.chatBodies = [];
    state.createdTaskId = undefined;
    state.batchCancels = [];
    state.taskCancels = [];
  });

  afterEach(() => {
    cleanup();
  });

  test("turns the URL into the API query", async () => {
    await renderList(
      `status=ended&whatRan=${pipelineId}&by=me&item=${itemId}&at=review&q=login`,
    );
    expect(state.requests[0]).toMatchObject({
      status: "ended",
      whatRan: pipelineId,
      startedBy: "me",
      workItemId: itemId,
      atNode: "review",
      q: "login",
    });
  });

  test("defaults to In progress and shows each tab's count", async () => {
    await renderList("");
    expect(state.requests[0]).toMatchObject({ status: "open" });
    const tabs = page().getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Needs you1",
      "In progress3",
      "Finished7",
      "All10",
    ]);
    expect(page().getByRole("tab", { selected: true }).textContent).toContain(
      "In progress",
    );
    expect(
      page()
        .getByRole("tab", { name: /Finished/ })
        .getAttribute("href"),
    ).toBe("/alice/demo/runs?status=finished");
  });

  test("shows removable chips for a narrowed deep link", async () => {
    await renderList(
      `status=ended&whatRan=${pipelineId}&item=${itemId}&at=review`,
    );
    const chips = page().getAllByTestId("runs-filter-chip");
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "Ended only",
      "At node review now",
      "On GH-12 or its children",
    ]);
    expect(page().getByRole("tab", { selected: true }).textContent).toContain(
      "Finished",
    );
    const clear = (index: number) =>
      within(chips[index] as HTMLElement)
        .getByLabelText("Clear filter")
        .getAttribute("href");
    expect(clear(0)).toBe(
      `/alice/demo/runs?status=finished&whatRan=${pipelineId}&item=${itemId}&at=review`,
    );
    expect(clear(1)).toBe(
      `/alice/demo/runs?status=ended&whatRan=${pipelineId}&item=${itemId}`,
    );
    expect(clear(2)).toBe(
      `/alice/demo/runs?status=ended&whatRan=${pipelineId}&at=review`,
    );
  });

  test("titles the page from its scope and drops What ran for a pipeline", async () => {
    await renderList(`whatRan=${pipelineId}`);
    expect(page().getByRole("heading").textContent).toBe("Ship it");
    expect(columnHeader().queryByText("What ran")).toBeNull();
    cleanup();

    await renderList(`item=${itemId}`);
    expect(page().getByRole("heading").textContent).toBe(
      "GH-12 · Fix the login bug",
    );
    expect(columnHeader().getByText("What ran")).toBeTruthy();
    cleanup();

    await renderList("by=me");
    expect(page().getByRole("heading").textContent).toBe("Started by you");
    cleanup();

    await renderList(`by=${automationId}`);
    expect(page().getByRole("heading").textContent).toBe("Triage new issues");
  });

  test("lists the facets with counts, hints and needs-you dots", async () => {
    await renderList("");
    const links = sidebar().getAllByTestId("runs-side-link");
    expect(links.map((link) => link.textContent)).toEqual([
      "All runs●3",
      "Triage new issuesproject●2",
      "You1",
      "Ship it●2",
      "Busy step1",
      "Tasks",
    ]);
    expect(
      sidebar()
        .getByRole("link", { name: /Ship it/ })
        .getAttribute("href"),
    ).toBe(`/alice/demo/runs?whatRan=${pipelineId}`);
    expect(
      sidebar()
        .getByRole("link", { name: /Pipelines & Automations/ })
        .getAttribute("href"),
    ).toBe("/alice/demo/pipelines");

    fireEvent.click(sidebar().getByText("Show all 2 steps"));
    expect(sidebar().getByText("Idle step")).toBeTruthy();
  });

  test("says nothing waits on you on an empty Needs you tab", async () => {
    state.runs = [];
    await renderList("status=needs-you");
    expect(page().getByTestId("runs-empty").textContent).toContain(
      "Nothing here is waiting on you.",
    );
  });

  test("says what search looks at when nothing matches", async () => {
    state.runs = [];
    await renderList("q=zebra");
    const empty = page().getByTestId("runs-empty").textContent;
    expect(empty).toContain("No runs match “zebra”.");
    expect(empty).toContain("Search looks at titles, work item keys");
  });

  test("writes search to the URL once typing settles", async () => {
    await renderList("status=all");
    fireEvent.change(page().getByLabelText("Search runs"), {
      target: { value: "  login " },
    });
    expect(state.replaced).toEqual([]);
    await act(async () => {
      await Bun.sleep(400);
    });
    expect(state.replaced).toEqual(["/alice/demo/runs?status=all&q=login"]);
  });

  const startTask = async () => {
    await renderList("");
    fireEvent.click(page().getByRole("button", { name: "＋ New task" }));
    fireEvent.change(page().getByLabelText("Your question"), {
      target: { value: "How does auth work?" },
    });
    fireEvent.click(page().getByLabelText("Start task"));
  };

  test("starts a Task from the inline composer and opens its Task page, members only", async () => {
    state.createdTaskId = id("900");
    await startTask();
    expect(page().getByText("＋ New task about this project")).toBeTruthy();
    await waitFor(() => {
      expect(state.pushed).toEqual([`/alice/demo/runs/tasks/${id("900")}`]);
    });
    expect(state.chatBodies).toEqual(["How does auth work?"]);
    cleanup();

    await renderList("", false);
    expect(page().queryByRole("button", { name: "＋ New task" })).toBeNull();
  });

  test("goes through the conversation redirect when the new Task has no id", async () => {
    await startTask();
    await waitFor(() => {
      expect(state.pushed).toEqual([`/alice/demo/conversations/${id("800")}`]);
    });
  });

  test("opens the composer for ?compose=1 and drops it from the URL, members only", async () => {
    await renderList(`whatRan=task&compose=1`);
    expect(page().getByLabelText("Your question")).toBeTruthy();
    expect(state.replaced).toEqual(["/alice/demo/runs?whatRan=task"]);
    cleanup();

    await renderList(`whatRan=task&compose=1`, false);
    expect(page().queryByLabelText("Your question")).toBeNull();
  });

  describe("batch cancel", () => {
    const canCancel = ["executions:write"];
    const mixedRuns = () => [
      buildRun({ id: id("501"), title: "Running pipeline" }),
      buildRun({
        type: "step",
        id: id("601"),
        title: "Queued step",
        status: "queued",
      }),
      buildRun({
        type: "task",
        id: id("801"),
        title: "Repo question",
        workItem: null,
        status: "waiting",
      }),
      buildRun({ id: id("502"), title: "Done pipeline", status: "done" }),
    ];
    const selectButton = () => page().queryByRole("button", { name: "Select" });

    test("offers Select only to members who may write executions", async () => {
      await renderList("", true, canCancel);
      expect(selectButton()).toBeTruthy();
      cleanup();

      await renderList("", true, []);
      expect(selectButton()).toBeNull();
      cleanup();

      await renderList("", false, canCancel);
      expect(selectButton()).toBeNull();
    });

    test("gives checkboxes only to in-progress pipeline runs and Tasks", async () => {
      state.runs = mixedRuns();
      await renderList("status=all", true, canCancel);
      expect(page().queryAllByRole("checkbox")).toHaveLength(0);
      fireEvent.click(page().getByRole("button", { name: "Select" }));
      const labels = page()
        .getAllByRole("checkbox")
        .map((box) => box.getAttribute("aria-label"));
      expect(labels).toEqual([
        "Select all cancellable runs",
        "Select Running pipeline",
        "Select Queued step",
        "Select Repo question",
      ]);
    });

    test("clears the selection when the query changes", async () => {
      state.runs = mixedRuns();
      const view = await renderList("status=all", true, canCancel);
      fireEvent.click(page().getByRole("button", { name: "Select" }));
      fireEvent.click(page().getByLabelText("Select Running pipeline"));
      expect(page().getByRole("button", { name: "Cancel 1 run" })).toBeTruthy();

      state.search = "status=all&q=login";
      view.rerender(
        await withProjectRoute(
          <RunsList projectId={id("100")} />,
          canCancel,
          true,
        ),
      );
      await waitFor(() => {
        expect(
          page().getByRole("button", { name: "Cancel 0 runs" }),
        ).toBeTruthy();
      });
    });

    test("cancels the selection, reports it and re-reads the list", async () => {
      state.runs = mixedRuns();
      await renderList("status=all", true, canCancel);
      fireEvent.click(page().getByRole("button", { name: "Select" }));
      fireEvent.click(page().getByLabelText("Select all cancellable runs"));
      fireEvent.click(page().getByRole("button", { name: "Cancel 3 runs" }));
      const requestsBefore = state.requests.length;
      fireEvent.click(page().getByRole("button", { name: "Cancel runs" }));

      await waitFor(() => {
        expect(page().getByText("Cancelled 3 runs.")).toBeTruthy();
      });
      expect(state.batchCancels).toEqual([[id("501")]]);
      expect(state.taskCancels).toEqual([id("601"), id("801")]);
      await waitFor(() => {
        expect(selectButton()).toBeTruthy();
        expect(state.requests.length).toBeGreaterThan(requestsBefore);
      });
    });
  });
});

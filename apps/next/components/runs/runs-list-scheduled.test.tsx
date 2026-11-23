/**
 * The Runs list scoped to scheduled Tasks: the Scheduled facet, and one
 * schedule's history (`?schedule=`) with its title and removable chip.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { withProjectRoute } from "@/components/tasks/tasks-test-support";
import type { ProjectRun, RunsCounts } from "./runs-api";
import {
  buildCounts,
  buildScheduledRun,
  id,
  scheduleId,
  viewerId,
} from "./runs-list-fixtures";

const state = {
  search: "",
  requests: [] as Record<string, unknown>[],
  runs: [] as ProjectRun[],
  counts: null as RunsCounts | null,
};

void mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
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
        automations: { get: () => Promise.resolve({ data: [], error: null }) },
      }),
    },
  }),
}));

const { cleanup, render, waitFor, within } =
  await import("@testing-library/react");
const { RunsList } = await import("./runs-list");

const page = () => within(document.body);

const renderList = async (search: string) => {
  state.search = search;
  render(await withProjectRoute(<RunsList projectId={id("100")} />));
  await waitFor(() => {
    expect(page().queryByLabelText("Loading runs")).toBeNull();
  });
};

describe("RunsList scoped to schedules", () => {
  beforeEach(() => {
    const counts = buildCounts();
    state.requests = [];
    state.runs = [buildScheduledRun()];
    state.counts = {
      ...counts,
      startedBy: [
        ...counts.startedBy,
        {
          filter: "scheduled",
          label: "Scheduled",
          inProgress: 1,
          needsYou: false,
        },
      ],
    };
  });

  afterEach(() => {
    cleanup();
  });

  test("the Scheduled facet narrows to scheduled Tasks", async () => {
    await renderList("by=scheduled");
    expect(state.requests[0]).toMatchObject({ startedBy: "scheduled" });
    expect(page().getByRole("heading").textContent).toBe("Scheduled");
    const facet = within(page().getByRole("navigation")).getByRole("link", {
      name: /^Scheduled/,
    });
    expect(facet.getAttribute("href")).toBe("/alice/demo/runs?by=scheduled");
    expect(facet.getAttribute("aria-current")).toBe("page");
  });

  test("a schedule's history is titled by it, with a removable chip", async () => {
    await renderList(`status=all&schedule=${scheduleId}`);
    expect(state.requests[0]).toMatchObject({ status: "all", scheduleId });
    expect(page().getByRole("heading").textContent).toBe("Poller · hourly");
    const chip = page().getByTestId("runs-filter-chip");
    expect(chip.textContent).toBe("Started by Poller · hourly");
    expect(
      within(chip).getByLabelText("Clear filter").getAttribute("href"),
    ).toBe("/alice/demo/runs?status=all");
  });
});

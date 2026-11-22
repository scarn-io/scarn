/**
 * The Runs list polls while the tab is visible, pauses while it is hidden,
 * refreshes on inbox changes, and pages with the cursor.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { installDom as installTestDom } from "@/tests/support/install-dom";

const POLL_MS = 30;
const projectId = "019e9a92-b432-73e8-9341-3519156fa600";

type RunsGetQuery = Record<string, unknown>;
let requests: RunsGetQuery[] = [];

const counts = {
  tabs: { "needs-you": 0, open: 0, finished: 0, all: 0 },
  overall: { inProgress: 0, needsYou: false },
  startedBy: [],
  whatRan: [],
};

const fakeRun = (n: number) => ({ id: `run-${String(n)}` });

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      projects: () => ({
        runs: {
          get: ({ query }: { query: RunsGetQuery }) => {
            requests.push(query);
            const paging = query["before"] !== undefined;
            return Promise.resolve({
              data: {
                runs: paging ? [fakeRun(2)] : [fakeRun(1)],
                nextCursor: paging ? null : "cursor-1",
                counts,
              },
              error: null,
            });
          },
        },
      }),
    },
  }),
}));

const originalEvent = globalThis.Event;
let hidden = false;

installDom();
const { act, cleanup, renderHook, waitFor } =
  await import("@testing-library/react");
const { useProjectRuns } = await import("./use-project-runs");
const { notifyInboxChanged } = await import("@/components/inbox/inbox-api");

function installDom() {
  const dom = installTestDom();
  Object.defineProperty(dom.window.document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
  Object.assign(globalThis, {
    Event: dom.window.Event,
  });
}

function setHidden(value: boolean) {
  hidden = value;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

async function idle(ms: number) {
  await act(async () => {
    await Bun.sleep(ms);
  });
}

const openQuery = { status: "open" } as const;

describe("useProjectRuns", () => {
  beforeEach(() => {
    requests = [];
    hidden = false;
    installDom();
  });

  afterEach(() => {
    cleanup();
  });

  afterAll(() => {
    globalThis.Event = originalEvent;
  });

  test("loads the first page with the query", async () => {
    const { result } = renderHook(() =>
      useProjectRuns(projectId, { status: "all", q: "login" }, 60_000),
    );
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.runs).toHaveLength(1);
    expect(result.current.hasMore).toBe(true);
    expect(requests[0]).toEqual({ status: "all", limit: 50, q: "login" });
  });

  test("polls while visible", async () => {
    renderHook(() => useProjectRuns(projectId, openQuery, POLL_MS));
    await waitFor(() => {
      expect(requests.length).toBeGreaterThanOrEqual(3);
    });
  });

  test("a hidden tab skips due polls, then refreshes once on becoming visible", async () => {
    renderHook(() => useProjectRuns(projectId, openQuery, POLL_MS));
    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });

    setHidden(true);
    await idle(POLL_MS * 4);
    expect(requests).toHaveLength(1);

    setHidden(false);
    await waitFor(
      () => {
        expect(requests).toHaveLength(2);
      },
      { interval: 5 },
    );
  });

  test("mounting in a hidden tab waits until it becomes visible", async () => {
    hidden = true;
    renderHook(() => useProjectRuns(projectId, openQuery, POLL_MS));
    await idle(POLL_MS * 3);
    expect(requests).toHaveLength(0);

    setHidden(false);
    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
  });

  test("notifyInboxChanged refreshes the list", async () => {
    renderHook(() => useProjectRuns(projectId, openQuery, 60_000));
    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });

    act(() => {
      notifyInboxChanged();
    });
    await waitFor(() => {
      expect(requests).toHaveLength(2);
    });
  });

  test("load more appends the next page, and a refresh keeps it on screen", async () => {
    const { result } = renderHook(() =>
      useProjectRuns(projectId, openQuery, 60_000),
    );
    await waitFor(() => {
      expect(result.current.hasMore).toBe(true);
    });

    act(() => {
      result.current.loadMore();
    });
    await waitFor(() => {
      expect(result.current.runs.map((run) => String(run.id))).toEqual([
        "run-1",
        "run-2",
      ]);
    });
    expect(requests[1]).toMatchObject({ before: "cursor-1" });
    expect(result.current.hasMore).toBe(false);

    act(() => {
      result.current.refresh();
    });
    await waitFor(() => {
      expect(requests).toHaveLength(3);
    });
    expect(requests[2]).toEqual({ status: "open", limit: 50 });
  });

  test("a new query reloads at once and shows loading until it arrives", async () => {
    const { result, rerender } = renderHook(
      ({ q }: { q: string }) =>
        useProjectRuns(projectId, { status: "open", q }, 60_000),
      { initialProps: { q: "a" } },
    );
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    rerender({ q: "b" });
    expect(result.current.loading).toBe(true);
    await waitFor(() => {
      expect(requests.at(-1)).toMatchObject({ q: "b" });
      expect(result.current.loading).toBe(false);
    });
  });
});

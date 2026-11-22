/**
 * Inbox polling pauses while the tab is hidden: a due poll makes no request,
 * and the owed refresh runs once when the tab becomes visible again.
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

let summaryRequests = 0;

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      projects: () => ({
        inbox: {
          summary: {
            get: () => {
              summaryRequests += 1;
              return Promise.resolve({
                data: {
                  waitingOnMe: 0,
                  failedStartedByMe: 0,
                  pipelineWaitsOnMe: 0,
                  workItemsWaitingOnMe: 0,
                  badgeCount: summaryRequests,
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

const { act, cleanup, renderHook, waitFor } =
  await import("@testing-library/react");
const { useInboxBadgeCount } = await import("./use-project-inbox");
const { notifyInboxChanged } = await import("./inbox-api");

const originalEvent = globalThis.Event;
let hidden = false;

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

describe("useInboxBadgeCount polling", () => {
  beforeEach(() => {
    summaryRequests = 0;
    hidden = false;
    installDom();
  });

  afterEach(() => {
    cleanup();
  });

  afterAll(() => {
    globalThis.Event = originalEvent;
  });

  test("polls the summary while visible", async () => {
    renderHook(() => useInboxBadgeCount(projectId, POLL_MS));

    await waitFor(() => {
      expect(summaryRequests).toBeGreaterThanOrEqual(3);
    });
  });

  test("a hidden tab skips due polls, then refreshes once on becoming visible and resumes", async () => {
    const { result } = renderHook(() => useInboxBadgeCount(projectId, POLL_MS));
    await waitFor(() => {
      expect(summaryRequests).toBe(1);
    });

    setHidden(true);
    await idle(POLL_MS * 4);
    expect(summaryRequests).toBe(1);

    setHidden(false);
    await waitFor(
      () => {
        expect(summaryRequests).toBe(2);
        expect(result.current).toBe(2);
      },
      { interval: 5 },
    );

    await waitFor(() => {
      expect(summaryRequests).toBeGreaterThanOrEqual(3);
    });
  });

  test("mounting in a hidden tab waits until it becomes visible", async () => {
    hidden = true;
    renderHook(() => useInboxBadgeCount(projectId, POLL_MS));
    await idle(POLL_MS * 3);
    expect(summaryRequests).toBe(0);

    setHidden(false);
    await waitFor(() => {
      expect(summaryRequests).toBe(1);
    });
  });

  test("becoming visible without an owed refresh makes no extra request", async () => {
    renderHook(() => useInboxBadgeCount(projectId, 60_000));
    await waitFor(() => {
      expect(summaryRequests).toBe(1);
    });

    setHidden(true);
    setHidden(false);
    await idle(POLL_MS);
    expect(summaryRequests).toBe(1);
  });

  test("notifyInboxChanged refreshes while visible", async () => {
    renderHook(() => useInboxBadgeCount(projectId, 60_000));
    await waitFor(() => {
      expect(summaryRequests).toBe(1);
    });

    act(() => {
      notifyInboxChanged();
    });
    await waitFor(() => {
      expect(summaryRequests).toBe(2);
    });
  });

  test("notifyInboxChanged while hidden waits until the tab is visible", async () => {
    renderHook(() => useInboxBadgeCount(projectId, 60_000));
    await waitFor(() => {
      expect(summaryRequests).toBe(1);
    });

    setHidden(true);
    act(() => {
      notifyInboxChanged();
    });
    await idle(POLL_MS);
    expect(summaryRequests).toBe(1);

    setHidden(false);
    await waitFor(() => {
      expect(summaryRequests).toBe(2);
    });
  });
});

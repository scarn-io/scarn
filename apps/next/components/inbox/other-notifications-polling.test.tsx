import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const { projectId, withProjectRoute } =
  await import("@/components/tasks/tasks-test-support");

const state = { reads: 0 };

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      projects: () => ({
        tasks: {
          get: () =>
            Promise.resolve({
              data: { tasks: [], nextCursor: null, counts: {} },
              error: null,
            }),
        },
        inbox: {
          waits: {
            get: () =>
              Promise.resolve({
                data: { waits: [], workItems: [] },
                error: null,
              }),
          },
          summary: {
            get: () =>
              Promise.resolve({
                data: {
                  waitingOnMe: 0,
                  failedStartedByMe: 0,
                  pipelineWaitsOnMe: 0,
                  workItemsWaitingOnMe: 0,
                  badgeCount: 0,
                  waitingOnOthers: 0,
                },
                error: null,
              }),
          },
        },
        notifications: {
          get: () => {
            state.reads += 1;
            return Promise.resolve({ data: [], error: null });
          },
        },
      }),
    },
  }),
}));

void mock.module("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {} }),
  usePathname: () => "/alice/demo/inbox",
  useSearchParams: () => new URLSearchParams(),
}));

const { cleanup, render, waitFor } = await import("@testing-library/react");
const { ProjectInbox } = await import("./project-inbox");

const setHidden = (hidden: boolean) => {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: hidden,
  });
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Inbox Other notifications", () => {
  beforeEach(() => {
    state.reads = 0;
    setHidden(false);
  });

  afterEach(() => {
    cleanup();
  });

  test("re-reads on an interval while visible, pauses while hidden, and catches up on visible", async () => {
    const view = render(
      await withProjectRoute(
        <ProjectInbox
          projectId={projectId}
          initialNotifications={[]}
          pollIntervalMs={20}
        />,
      ),
    );
    expect(view.getByText("Other notifications")).toBeTruthy();
    expect(state.reads).toBe(0);

    await waitFor(() => {
      expect(state.reads).toBeGreaterThanOrEqual(2);
    });

    setHidden(true);
    await sleep(30);
    const whileHidden = state.reads;
    await sleep(80);
    expect(state.reads).toBe(whileHidden);

    setHidden(false);
    document.dispatchEvent(new window.Event("visibilitychange"));
    await waitFor(() => {
      expect(state.reads).toBeGreaterThan(whileHidden);
    });
  });
});

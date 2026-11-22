/**
 * A work item's Tasks poll only while one is still moving, and the polling
 * pauses while the tab is hidden.
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
import type { TaskSummary } from "@/components/tasks/task-api";
import { installDom as installTestDom } from "@/tests/support/install-dom";

const POLL_MS = 30;
const projectId = "019e9a92-b432-73e8-9341-3519156fa900";
const workItemId = "019e9a92-b432-73e8-9341-3519156fa901";

let requests = 0;
let taskStatus: TaskSummary["status"] = "running";

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      projects: () => ({
        tasks: {
          get: () => {
            requests += 1;
            return Promise.resolve({
              data: {
                tasks: [{ id: "task", status: taskStatus }],
                nextCursor: null,
              },
              error: null,
            });
          },
        },
      }),
    },
  }),
}));

const { act, cleanup, renderHook, waitFor } =
  await import("@testing-library/react");
const { useWorkItemTasks } = await import("./use-work-item-tasks");

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

describe("useWorkItemTasks polling", () => {
  beforeEach(() => {
    requests = 0;
    taskStatus = "running";
    hidden = false;
    installDom();
  });

  afterEach(() => {
    cleanup();
  });

  afterAll(() => {
    globalThis.Event = originalEvent;
  });

  test("polls while a Task is still moving", async () => {
    renderHook(() => useWorkItemTasks(projectId, workItemId, POLL_MS));

    await waitFor(() => {
      expect(requests).toBeGreaterThanOrEqual(3);
    });
  });

  test("stops polling once no Task is moving", async () => {
    taskStatus = "succeeded";
    const { result } = renderHook(() =>
      useWorkItemTasks(projectId, workItemId, POLL_MS),
    );
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await idle(POLL_MS * 3);
    expect(requests).toBe(1);
  });

  test("a hidden tab skips due polls, then reloads once on becoming visible and resumes", async () => {
    renderHook(() => useWorkItemTasks(projectId, workItemId, POLL_MS));
    await waitFor(() => {
      expect(requests).toBe(1);
    });

    setHidden(true);
    await idle(POLL_MS * 4);
    expect(requests).toBe(1);

    setHidden(false);
    await waitFor(() => {
      expect(requests).toBe(2);
    });
    await waitFor(() => {
      expect(requests).toBeGreaterThanOrEqual(3);
    });
  });

  test("mounting in a hidden tab waits until it becomes visible", async () => {
    hidden = true;
    renderHook(() => useWorkItemTasks(projectId, workItemId, POLL_MS));
    await idle(POLL_MS * 3);
    expect(requests).toBe(0);

    setHidden(false);
    await waitFor(() => {
      expect(requests).toBe(1);
    });
  });
});

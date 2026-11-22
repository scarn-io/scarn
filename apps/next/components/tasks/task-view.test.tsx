import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import {
  api,
  buildTask,
  buildTaskRun,
  projectId,
  resetApi,
  withProjectRoute,
} from "./tasks-test-support";

const { act, cleanup, fireEvent, render, renderHook, waitFor } =
  await import("@testing-library/react");
const { TaskView, taskRunsDuration, useTask } = await import("./task-view");

const POLL_MS = 30;
const taskId = "019e9a92-b432-73e8-9341-3519156fa801";
let hidden = false;

function setHidden(value: boolean) {
  hidden = value;
  act(() => {
    document.dispatchEvent(new window.Event("visibilitychange"));
  });
}

async function idle(ms: number) {
  await act(async () => {
    await Bun.sleep(ms);
  });
}

const renderView = async (permissions: string[] = [], isMember = true) =>
  await act(async () =>
    render(
      await withProjectRoute(
        <TaskView
          taskId="019e9a92-b432-73e8-9341-3519156fa801"
          projectId={projectId}
        />,
        permissions,
        isMember,
      ),
    ),
  );

describe("taskRunsDuration", () => {
  test("is null before any run has started", () => {
    expect(taskRunsDuration([])).toBeNull();
    expect(
      taskRunsDuration([{ startedAt: null, completedAt: null }]),
    ).toBeNull();
  });

  test("spans the first run's start to the last run's end", () => {
    expect(
      taskRunsDuration([
        {
          startedAt: "2026-10-01T12:00:00.000Z",
          completedAt: "2026-10-01T12:01:00.000Z",
        },
        {
          startedAt: "2026-10-01T12:05:00.000Z",
          completedAt: "2026-10-01T12:07:30.000Z",
        },
      ]),
    ).toBe("7m 30s");
  });

  test("runs to now while the last run is going", () => {
    expect(
      taskRunsDuration(
        [{ startedAt: "2026-10-01T12:00:00.000Z", completedAt: null }],
        new Date("2026-10-01T12:00:42.000Z").getTime(),
      ),
    ).toBe("42s");
  });
});

describe("TaskView", () => {
  beforeEach(() => {
    resetApi();
  });

  afterEach(() => {
    cleanup();
  });

  test("the header has a breadcrumb back to Runs and a caption linking the work item", async () => {
    api.taskDetail = {
      ...buildTask({ status: "succeeded" }),
      errorJson: null,
      resultJson: null,
    };
    const view = await renderView();

    await waitFor(() => {
      expect(view.getByRole("heading", { name: "Implement" })).toBeTruthy();
    });
    const breadcrumb = view.getByRole("navigation", { name: "Breadcrumb" });
    expect(breadcrumb.querySelector("a")?.getAttribute("href")).toBe(
      "/alice/demo/runs",
    );
    const caption = view.getByTestId("task-caption");
    expect(caption.textContent).toContain("Agent");
    expect(caption.textContent).toContain("Started by alice");
    expect(
      view
        .getByRole("link", { name: "GH-12 Fix the bug" })
        .getAttribute("href"),
    ).toBe("/alice/demo/work-items/019e9a92-b432-73e8-9341-3519156fa901");
    expect(view.getByRole("tab", { name: "Transcript" })).toBeTruthy();
  });

  test("a chat Task is titled by its question and links no work item", async () => {
    const chat = { id: parseUuidV7(taskId), title: "Where is auth?" };
    const task = buildTask({ workItem: null, repoConversation: chat });
    api.taskDetail = { ...task, errorJson: null, resultJson: null };
    const view = await renderView();

    await view.findByRole("heading", { name: "Where is auth?" });
    const links = view.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(links.some((href) => href?.includes("/work-items/"))).toBe(false);
    expect(links.some((href) => href?.includes("/runs/chats/"))).toBe(false);
  });

  test("a pipeline Task links its run and names its node", async () => {
    const runId = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa910");
    api.taskDetail = {
      ...buildTask({ pipelineRunId: runId, nodeId: "implement-node" }),
      errorJson: null,
      resultJson: null,
    };
    const view = await renderView();

    await waitFor(() => {
      expect(view.getByText("implement-node")).toBeTruthy();
    });
    expect(
      view.getByRole("link", { name: "Pipeline run" }).getAttribute("href"),
    ).toBe(`/alice/demo/runs/${runId}`);
  });

  test("a code Task has no Transcript tab and opens on its logs", async () => {
    api.taskDetail = {
      ...buildTask({ kind: "code", status: "succeeded" }),
      errorJson: null,
      resultJson: null,
    };
    const view = await renderView();

    await waitFor(() => {
      expect(view.getByRole("tab", { name: "Logs" })).toBeTruthy();
    });
    expect(view.queryByRole("tab", { name: "Transcript" })).toBeNull();
    expect(
      view.getByRole("tab", { name: "Logs" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(view.getByTestId("task-caption").textContent).toContain("Code step");
  });
});

describe("useTask polling", () => {
  beforeEach(() => {
    resetApi();
    hidden = false;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => hidden,
    });
    api.taskDetail = {
      ...buildTask({ status: "running" }),
      errorJson: null,
      resultJson: null,
    };
  });

  afterEach(() => {
    cleanup();
    delete (document as { hidden?: boolean }).hidden;
  });

  test("polls a live Task while visible", async () => {
    renderHook(() => useTask(taskId, projectId, POLL_MS));

    await waitFor(() => {
      expect(api.taskDetailRequests).toBeGreaterThanOrEqual(3);
    });
  });

  test("refreshing a terminal task into queued immediately reloads both resources and resumes polling", async () => {
    api.taskDetail = {
      ...buildTask({ status: "cancelled" }),
      errorJson: null,
      resultJson: null,
    };
    const { result } = renderHook(() => useTask(taskId, projectId, POLL_MS));
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    await idle(POLL_MS * 2);
    expect(api.taskDetailRequests).toBe(1);
    api.taskDetail = {
      ...buildTask({ status: "queued" }),
      errorJson: null,
      resultJson: null,
    };
    act(() => {
      result.current.reload();
    });
    await waitFor(() => {
      expect(api.taskDetailRequests).toBeGreaterThanOrEqual(3);
    });
    expect(api.taskRunsRequests).toBe(api.taskDetailRequests);
  });

  test("a hidden tab skips due polls, then reloads once on becoming visible and resumes", async () => {
    renderHook(() => useTask(taskId, projectId, POLL_MS));
    await waitFor(() => {
      expect(api.taskDetailRequests).toBe(1);
    });

    setHidden(true);
    await idle(POLL_MS * 4);
    expect(api.taskDetailRequests).toBe(1);

    setHidden(false);
    await waitFor(() => {
      expect(api.taskDetailRequests).toBe(2);
    });
    await waitFor(() => {
      expect(api.taskDetailRequests).toBeGreaterThanOrEqual(3);
    });
  });

  test("mounting in a hidden tab waits until it becomes visible", async () => {
    hidden = true;
    const { result } = renderHook(() => useTask(taskId, projectId, POLL_MS));
    await idle(POLL_MS * 3);
    expect(api.taskDetailRequests).toBe(0);
    expect(result.current.status).toBe("loading");

    setHidden(false);
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
  });
});

describe("TaskView retry", () => {
  beforeEach(() => {
    resetApi();
    api.taskDetail = {
      ...buildTask({ status: "failed", kind: "code" }),
      errorJson: null,
      resultJson: null,
    };
    api.taskRuns = [buildTaskRun({ kind: "code" })];
  });
  afterEach(cleanup);

  test("submits the expected latest run once, disables while pending, refreshes and selects the new attempt", async () => {
    let finish!: () => void;
    api.retry = () =>
      new Promise((resolve) => {
        finish = () => {
          resolve({ data: { taskId, taskRunId: null }, error: null });
        };
      });
    const view = await renderView(["executions:write"]);
    await waitFor(() => {
      expect(view.getByRole("button", { name: "Retry task" })).toBeTruthy();
    });
    fireEvent.click(view.getByRole("combobox", { name: "Logs run" }));
    fireEvent.keyDown(view.getByRole("combobox", { name: "Logs run" }), {
      key: "ArrowDown",
    });
    const option = await view.findByRole("option", { name: /Run 1/ });
    fireEvent.click(option);
    fireEvent.click(view.getByRole("button", { name: "Retry task" }));
    expect(
      view.getByRole("button", { name: "Retrying…" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "Retrying…" }));
    expect(api.retryBodies).toEqual([
      { expectedLatestRunId: buildTaskRun().id },
    ]);
    api.taskDetail = {
      ...buildTask({ status: "queued", kind: "code" }),
      errorJson: null,
      resultJson: null,
    };
    api.taskRuns = [
      buildTaskRun(),
      buildTaskRun({
        id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa812"),
        number: 2,
        reason: "retry",
        status: "queued",
      }),
    ];
    act(() => {
      finish();
    });
    await waitFor(() => {
      expect(
        view.getByRole("combobox", { name: "Logs run" }).textContent,
      ).toContain("Run 2");
    });
    expect(api.taskDetailRequests).toBe(2);
    expect(api.taskRunsRequests).toBe(2);
    expect(view.queryByRole("button", { name: "Retry task" })).toBeNull();
  });

  test.each(["failed", "timeout", "abandoned", "cancelled"] as const)(
    "offers retry for a failed task with a %s run",
    async (status) => {
      api.taskRuns = [buildTaskRun({ status })];
      const view = await renderView(["executions:write"]);
      expect(
        await view.findByRole("button", { name: "Retry task" }),
      ).toBeTruthy();
    },
  );

  test.each([false, true])(
    "retries cancelled tasks with nullable latest run (yielded=%s)",
    async (yielded) => {
      api.taskDetail = {
        ...buildTask({ status: "cancelled" }),
        errorJson: null,
        resultJson: null,
      };
      api.taskRuns = yielded ? [buildTaskRun({ status: "yielded" })] : [];
      const view = await renderView(["executions:write"]);
      fireEvent.click(await view.findByRole("button", { name: "Retry task" }));
      await waitFor(() => {
        expect(api.retryBodies).toEqual([
          { expectedLatestRunId: yielded ? buildTaskRun().id : null },
        ]);
      });
    },
  );

  test.each(["running", "succeeded", "waiting_for_person", "queued"] as const)(
    "hides retry for a %s task",
    async (status) => {
      api.taskDetail = {
        ...buildTask({ status }),
        errorJson: null,
        resultJson: null,
      };
      const view = await renderView(["executions:write"]);
      await view.findByRole("heading");
      expect(view.queryByRole("button", { name: "Retry task" })).toBeNull();
    },
  );

  test.each([null, "yielded", "succeeded", "running"] as const)(
    "hides retry for failed task with unsupported latest run %s",
    async (status) => {
      api.taskRuns = status ? [buildTaskRun({ status })] : [];
      const view = await renderView(["executions:write"]);
      await view.findByRole("heading");
      expect(view.queryByRole("button", { name: "Retry task" })).toBeNull();
    },
  );

  test.each([true, false])(
    "hides write actions for readonly/public viewers (member=%s)",
    async (isMember) => {
      const view = await renderView(
        isMember ? ["executions:read"] : ["executions:write"],
        isMember,
      );
      await view.findByRole("heading");
      expect(view.queryByRole("button", { name: "Retry task" })).toBeNull();
      expect(api.retryBodies).toEqual([]);
    },
  );

  test("pipeline tasks link to the existing rerun flow without calling retry", async () => {
    api.taskDetail = {
      ...buildTask({ status: "failed", pipelineRunId: parseUuidV7(taskId) }),
      errorJson: null,
      resultJson: null,
    };
    const view = await renderView(["executions:write"]);
    const link = await view.findByRole("link", { name: "Re-run in pipeline" });
    expect(link.getAttribute("href")).toBe(`/alice/demo/runs/${taskId}`);
    expect(view.queryByRole("button", { name: "Retry task" })).toBeNull();
    expect(api.retryBodies).toEqual([]);
  });

  test.each([
    ["TASK_RETRY_STALE_RUN", "This task changed"],
    ["TASK_NOT_RETRYABLE", "This task changed"],
    ["Scarn.ConcurrencyGroupFull", "concurrency group is full"],
    ["UNKNOWN", "Could not retry"],
  ])(
    "shows actionable %s errors with a refresh action",
    async (code, message) => {
      api.retry = () =>
        Promise.resolve({
          data: { taskId, taskRunId: null },
          error: { value: { code } },
        });
      const view = await renderView(["executions:write"]);
      fireEvent.click(await view.findByRole("button", { name: "Retry task" }));
      await waitFor(() => {
        expect(view.getByRole("alert").textContent).toContain(message);
      });
      expect(
        view
          .getByRole("button", { name: "Retry task" })
          .hasAttribute("disabled"),
      ).toBe(false);
      fireEvent.click(view.getByRole("button", { name: "Refresh task" }));
      await waitFor(() => {
        expect(api.taskDetailRequests).toBe(2);
      });
    },
  );
});

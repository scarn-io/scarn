/**
 * `useStepThread`: when it fetches a visit's thread, and
 * `stepThreadRefreshKey`, the key callers derive from the execution poll.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import type {
  NodeVisitContract,
  VisitThreadContract,
} from "@scarn/api/frontend-contracts";
import { installDom } from "@/tests/support/install-dom";

const EXECUTION_ID = "019e9a92-b432-73e8-9341-3519156fa696";
const TASK_ID = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa699");
const VISIT_ID = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa697");

const THREAD: VisitThreadContract = {
  visitId: VISIT_ID,
  nodeId: "triage",
  runs: [
    {
      taskRunId: TASK_ID,
      previousTaskRunId: null,
      status: "succeeded",
      createdAt: "2026-10-16T10:00:00.000Z",
      messages: [],
      sessionRestored: null,
    },
  ],
};

const getThreadMock = mock(() =>
  Promise.resolve({ data: THREAD, error: null }),
);
const visitsMock = mock((params: { visitId: string }) => ({
  visitId: params.visitId,
  thread: { get: getThreadMock },
}));

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      "pipeline-executions": () => ({ visits: visitsMock }),
    },
  }),
}));

const { stepThreadRefreshKey, useStepThread } =
  await import("./use-step-thread");

type HookProps = { visitId: string | null; refreshKey: string | null };

const renderThread = (initialProps: HookProps) =>
  renderHook(
    ({ visitId, refreshKey }: HookProps) =>
      useStepThread(EXECUTION_ID, visitId, refreshKey),
    { initialProps },
  );

describe("useStepThread", () => {
  beforeEach(() => {
    getThreadMock.mockClear();
    visitsMock.mockClear();
    installDom();
  });

  afterEach(() => {
    cleanup();
  });

  test("fetches the visit's thread on mount", async () => {
    const { result } = renderThread({ visitId: VISIT_ID, refreshKey: "a" });

    expect(result.current.loading).toBe(true);
    await waitFor(() => {
      expect(result.current.thread).toEqual(THREAD);
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe("");
    expect(visitsMock).toHaveBeenCalledWith({ visitId: VISIT_ID });
    expect(getThreadMock).toHaveBeenCalledTimes(1);
  });

  test("refetches only when the refresh key changes", async () => {
    const { result, rerender } = renderThread({
      visitId: VISIT_ID,
      refreshKey: "a",
    });
    await waitFor(() => {
      expect(result.current.thread).toEqual(THREAD);
    });

    rerender({ visitId: VISIT_ID, refreshKey: "a" });
    expect(getThreadMock).toHaveBeenCalledTimes(1);

    rerender({ visitId: VISIT_ID, refreshKey: "b" });
    expect(result.current.thread).toEqual(THREAD);
    await waitFor(() => {
      expect(getThreadMock).toHaveBeenCalledTimes(2);
    });
  });

  test("a null visit fetches nothing", () => {
    const { result } = renderThread({ visitId: null, refreshKey: null });

    expect(result.current).toEqual({ thread: null, loading: false, error: "" });
    expect(getThreadMock).not.toHaveBeenCalled();
  });

  test("reports a failed load", async () => {
    getThreadMock.mockImplementationOnce(() =>
      Promise.resolve({
        data: null as unknown as VisitThreadContract,
        error: { value: { message: "Visit not found" } } as unknown as null,
      }),
    );
    const { result } = renderThread({ visitId: VISIT_ID, refreshKey: "a" });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.thread).toBeNull();
    expect(result.current.error).not.toBe("");
  });
});

describe("stepThreadRefreshKey", () => {
  const visit = (
    nodeKind: NodeVisitContract["nodeKind"],
    tasks: NodeVisitContract["tasks"],
    questions: NodeVisitContract["questions"] = [],
  ) => ({ id: VISIT_ID, nodeKind, tasks, questions });
  const runningTask = {
    taskId: TASK_ID,
    attemptNumber: 1,
    status: "running" as const,
    startedAt: "2026-10-16T10:00:00.000Z",
    completedAt: null,
    workBranch: null,
  };

  test("combines the visit with its latest task's status and completion", () => {
    expect(stepThreadRefreshKey(visit("step", [runningTask]))).toBe(
      `${VISIT_ID}:${TASK_ID}:running::`,
    );
    expect(
      stepThreadRefreshKey(
        visit("step", [
          {
            ...runningTask,
            status: "succeeded",
            completedAt: "2026-10-16T10:01:00.000Z",
          },
        ]),
      ),
    ).toBe(`${VISIT_ID}:${TASK_ID}:succeeded:2026-10-16T10:01:00.000Z:`);
  });

  test("changes when the visit's question is answered", () => {
    const question = {
      questionId: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa720"),
      commentId: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa721"),
      taskRunId: TASK_ID,
      status: "open" as const,
    };
    const open = stepThreadRefreshKey(visit("step", [runningTask], [question]));
    const answered = stepThreadRefreshKey(
      visit("step", [runningTask], [{ ...question, status: "answered" }]),
    );
    expect(open).not.toBe(answered);
  });

  test("is null for no visit and for visits that run no task", () => {
    expect(stepThreadRefreshKey(null)).toBeNull();
    expect(stepThreadRefreshKey(visit("wait", []))).toBeNull();
  });
});

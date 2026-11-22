/**
 * `useExecutionDetail`: polling a live run pauses while the tab is hidden and
 * catches up once, without the loading spinner, when it is visible again.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  test,
} from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { buildRunExecution } from "./execution-detail-view.test-helpers";
import { installDom } from "@/tests/support/install-dom";

const projectId = "019e709b-574f-742c-8fda-00a1bcc71b9d";
const executionId = "019e9a92-b432-73e8-9341-3519156fa696";

const runningExecution = buildRunExecution({
  id: executionId,
  runStatus: "active",
  status: "running",
});

const getExecutionMock = mock(() =>
  Promise.resolve({ data: runningExecution, error: null }),
);

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      "pipeline-executions": () => ({ get: getExecutionMock }),
      "pipeline-definitions": () => ({
        get: () => Promise.reject(new Error("not needed")),
        versions: { get: () => Promise.resolve({ data: [], error: null }) },
      }),
      "work-items": () => ({
        get: () => Promise.reject(new Error("not needed")),
      }),
    },
  }),
}));

const { useExecutionDetail } = await import("./use-execution-detail");

describe("useExecutionDetail while the tab is hidden", () => {
  let hidden = false;

  const flush = async () => {
    await act(async () => {
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });
  };

  const advance = async (ms: number) => {
    act(() => {
      jest.advanceTimersByTime(ms);
    });
    await flush();
  };

  beforeEach(() => {
    hidden = false;
    getExecutionMock.mockClear();
    const dom = installDom();
    Object.defineProperty(dom.window.document, "hidden", {
      configurable: true,
      get: () => hidden,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    cleanup();
  });

  test("makes no requests while hidden, then catches up once without a spinner", async () => {
    jest.useFakeTimers();
    const loadingHistory: boolean[] = [];
    const { result } = renderHook(() => {
      const detail = useExecutionDetail(projectId, executionId);
      loadingHistory.push(detail.loading);
      return detail;
    });
    await flush();
    expect(getExecutionMock).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(false);
    expect(result.current.execution?.id).toBe(runningExecution.id);

    hidden = true;
    await advance(5_000);
    await advance(120_000);
    expect(getExecutionMock).toHaveBeenCalledTimes(1);

    loadingHistory.length = 0;
    hidden = false;
    act(() => {
      document.dispatchEvent(new window.Event("visibilitychange"));
    });
    await flush();
    expect(getExecutionMock).toHaveBeenCalledTimes(2);
    expect(loadingHistory).not.toContain(true);
    expect(result.current.loading).toBe(false);
  });
});

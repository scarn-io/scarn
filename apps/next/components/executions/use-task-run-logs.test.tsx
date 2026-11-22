/**
 * `useTaskRunLogs`: the archive path (once the feed reports `complete`, the
 * hook downloads the archive from a presigned URL, and a failed download is
 * reported rather than swallowed), live polling pausing while the tab is
 * hidden, and live lines arriving over the feed socket (reconnecting from the
 * cursor, loading the archive once sealed, polling when the feed is absent).
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
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { LogLineContract } from "@scarn/api/frontend-contracts";
import { installDom } from "@/tests/support/install-dom";

const taskId = "019e9a92-b432-73e8-9341-3519156fa699";
const ARCHIVE_URL = "http://localhost:9000/scarn-logs/log.ndjson";

type LogsPage = {
  lines: LogLineContract[];
  nextOffset: number;
  complete: boolean;
};
const FINISHED_PAGE: LogsPage = { lines: [], nextOffset: 0, complete: true };
let logsPage = FINISHED_PAGE;

type LogsRequest = { query: { from: number; limit: number } };

const getLogsMock = mock<
  (request?: LogsRequest) => Promise<{ data: LogsPage; error: null }>
>(() => Promise.resolve({ data: logsPage, error: null }));
const getArchiveMock = mock(() =>
  Promise.resolve({ data: { url: ARCHIVE_URL }, error: null }),
);

type TokenResponse =
  | { data: { url: string; token: string; expiresAt: string }; error: null }
  | { data: null; error: { status: number; value: unknown } };
const FEED_NOT_CONFIGURED: TokenResponse = {
  data: null,
  error: { status: 404, value: { status: 404, code: "NOT_FOUND" } },
};
let tokenResponse: TokenResponse = FEED_NOT_CONFIGURED;
const getTokenMock = mock(() => Promise.resolve(tokenResponse));

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      "task-runs": () => ({
        logs: Object.assign(
          { get: getLogsMock },
          { archive: { get: getArchiveMock } },
        ),
        "log-feed-token": { get: getTokenMock },
      }),
    },
  }),
}));

const { TaskRunLogsCacheProvider, useTaskRunLogs } =
  await import("./use-task-run-logs");

const ARCHIVED_LINE: LogLineContract = {
  seq: 1,
  stream: "worker",
  ts: "2026-10-04T18:17:35.539Z",
  content: "[step] hello",
  level: "info",
};

describe("useTaskRunLogs archive", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    logsPage = FINISHED_PAGE;
    getLogsMock.mockClear();
    getArchiveMock.mockClear();
    installDom();
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  test("loads the archived lines for a finished step", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(`${JSON.stringify(ARCHIVED_LINE)}\n`)),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => useTaskRunLogs(taskId, false));

    await waitFor(() => {
      expect(result.current.complete).toBe(true);
    });
    expect(result.current.lines).toEqual([ARCHIVED_LINE]);
    expect(result.current.error).toBe("");
  });

  test("reports a network or CORS failure instead of showing no logs", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new TypeError("Failed to fetch")),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => useTaskRunLogs(taskId, false));

    await waitFor(() => {
      expect(result.current.complete).toBe(true);
    });
    expect(result.current.lines).toEqual([]);
    expect(result.current.error).toContain("Couldn't load the archived logs");
    expect(result.current.error).toContain("CORS");
  });

  test("reports the status when storage rejects the download", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("expired", { status: 403 })),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => useTaskRunLogs(taskId, false));

    await waitFor(() => {
      expect(result.current.complete).toBe(true);
    });
    expect(result.current.error).toContain("Couldn't load the archived logs");
    expect(result.current.error).toContain("403");
  });

  test("under a TaskRunLogsCacheProvider, a finished feed is read once", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(`${JSON.stringify(ARCHIVED_LINE)}\n`)),
    ) as unknown as typeof fetch;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TaskRunLogsCacheProvider>{children}</TaskRunLogsCacheProvider>
    );

    const initialProps: { id: string | null } = { id: taskId };
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useTaskRunLogs(id, false),
      { wrapper, initialProps },
    );
    await waitFor(() => {
      expect(result.current.complete).toBe(true);
    });

    rerender({ id: null });
    rerender({ id: taskId });
    expect(result.current.complete).toBe(true);
    expect(result.current.lines).toEqual([ARCHIVED_LINE]);
    expect(getLogsMock).toHaveBeenCalledTimes(1);
    expect(getArchiveMock).toHaveBeenCalledTimes(1);
  });
});

describe("useTaskRunLogs while the tab is hidden", () => {
  let hidden = false;

  const flush = async () => {
    await act(async () => {
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
    });
  };

  const advance = async (ms: number) => {
    act(() => {
      jest.advanceTimersByTime(ms);
    });
    await flush();
  };

  const requestedOffsets = () =>
    getLogsMock.mock.calls.map(([request]) => request?.query.from);

  beforeEach(() => {
    hidden = false;
    tokenResponse = FEED_NOT_CONFIGURED;
    getLogsMock.mockClear();
    const dom = installDom();
    Object.defineProperty(dom.window.document, "hidden", {
      configurable: true,
      get: () => hidden,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    cleanup();
    logsPage = FINISHED_PAGE;
  });

  test("makes no requests while hidden, then continues from the cursor once visible", async () => {
    jest.useFakeTimers();
    logsPage = { lines: [ARCHIVED_LINE], nextOffset: 1, complete: false };
    const { result } = renderHook(() => useTaskRunLogs(taskId, true));
    await flush();
    expect(requestedOffsets()).toEqual([0]);
    expect(result.current.lines).toEqual([ARCHIVED_LINE]);

    logsPage = { lines: [], nextOffset: 1, complete: false };
    hidden = true;
    await advance(2_000);
    await advance(60_000);
    expect(requestedOffsets()).toEqual([0]);

    hidden = false;
    act(() => {
      document.dispatchEvent(new window.Event("visibilitychange"));
    });
    await flush();
    expect(requestedOffsets()).toEqual([0, 1]);
    expect(result.current.lines).toEqual([ARCHIVED_LINE]);
  });
});

class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readonly url: URL;
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];

  constructor(url: URL) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  receive(message: object) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(message) }),
    );
  }

  drop() {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

const logLine = (seq: number): LogLineContract => ({
  seq,
  stream: "worker",
  ts: "2026-10-04T18:17:35.539Z",
  content: `line ${String(seq)}`,
  level: "info",
});

describe("useTaskRunLogs over the feed socket", () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;

  const flush = async () => {
    await act(async () => {
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });
  };

  const latestSocket = () => {
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) throw new Error("no socket opened");
    return socket;
  };

  beforeEach(() => {
    FakeWebSocket.instances = [];
    tokenResponse = {
      data: {
        url: "wss://feed.example/task-runs/abc/ws",
        token: "read-token",
        expiresAt: "2026-11-12T00:15:00.000Z",
      },
      error: null,
    };
    logsPage = { lines: [], nextOffset: 0, complete: false };
    getLogsMock.mockClear();
    getArchiveMock.mockClear();
    getTokenMock.mockClear();
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const dom = installDom();
    Object.defineProperty(dom.window.document, "hidden", {
      configurable: true,
      get: () => false,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    cleanup();
    globalThis.WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
    logsPage = FINISHED_PAGE;
    tokenResponse = FEED_NOT_CONFIGURED;
  });

  test("lines arrive over the socket without polling GET /logs", async () => {
    const { result } = renderHook(() => useTaskRunLogs(taskId, true));
    await flush();

    const socket = latestSocket();
    expect(socket.url.searchParams.get("token")).toBe("read-token");
    expect(socket.url.searchParams.get("from")).toBe("0");

    act(() => {
      socket.receive({ t: "lines", lines: [logLine(1), logLine(2)] });
      socket.receive({ t: "caught-up", nextOffset: 2 });
      socket.receive({ t: "lines", lines: [logLine(2), logLine(3)] });
    });

    expect(result.current.lines).toEqual([logLine(1), logLine(2), logLine(3)]);
    expect(result.current.loading).toBe(false);
    expect(getLogsMock).not.toHaveBeenCalled();
    expect(socket.sent.every((message) => message === "ping")).toBe(true);
  });

  test("reconnects from the cursor with a fresh token after the socket drops", async () => {
    jest.useFakeTimers();
    const { result } = renderHook(() => useTaskRunLogs(taskId, true));
    await flush();

    act(() => {
      latestSocket().receive({ t: "lines", lines: [logLine(1), logLine(2)] });
      latestSocket().drop();
    });
    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    await flush();

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(getTokenMock).toHaveBeenCalledTimes(2);
    expect(latestSocket().url.searchParams.get("from")).toBe("2");

    act(() => {
      latestSocket().receive({ t: "lines", lines: [logLine(3)] });
    });
    expect(result.current.lines).toEqual([logLine(1), logLine(2), logLine(3)]);
    expect(getLogsMock).not.toHaveBeenCalled();
  });

  test("sealed loads the archive once and closes the socket", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          `${JSON.stringify(logLine(1))}\n${JSON.stringify(logLine(2))}\n`,
        ),
      ),
    ) as unknown as typeof fetch;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TaskRunLogsCacheProvider>{children}</TaskRunLogsCacheProvider>
    );
    const { result } = renderHook(
      () => ({
        conversation: useTaskRunLogs(taskId, true),
        logsView: useTaskRunLogs(taskId, true),
      }),
      { wrapper },
    );
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);

    const socket = latestSocket();
    act(() => {
      socket.receive({ t: "lines", lines: [logLine(1)] });
      socket.receive({ t: "caught-up", nextOffset: 1 });
      socket.receive({ t: "sealed" });
      socket.receive({ t: "sealed" });
    });

    await waitFor(() => {
      expect(result.current.conversation.complete).toBe(true);
    });
    expect(result.current.logsView.lines).toEqual([logLine(1), logLine(2)]);
    expect(getArchiveMock).toHaveBeenCalledTimes(1);
    expect(socket.readyState).toBe(3);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(getLogsMock).not.toHaveBeenCalled();
  });

  test("falls back to polling when the token route returns 404", async () => {
    tokenResponse = FEED_NOT_CONFIGURED;
    logsPage = { lines: [logLine(1)], nextOffset: 1, complete: false };

    const { result } = renderHook(() => useTaskRunLogs(taskId, true));
    await flush();

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(getLogsMock).toHaveBeenCalledTimes(1);
    expect(result.current.lines).toEqual([logLine(1)]);
  });

  test("a finished run skips the token and reads the archive", async () => {
    logsPage = FINISHED_PAGE;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(`${JSON.stringify(logLine(1))}\n`)),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => useTaskRunLogs(taskId, false));
    await waitFor(() => {
      expect(result.current.complete).toBe(true);
    });

    expect(getTokenMock).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(result.current.lines).toEqual([logLine(1)]);
  });
});

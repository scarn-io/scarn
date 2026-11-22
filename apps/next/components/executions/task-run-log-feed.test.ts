/**
 * `startTaskRunLogFeed` giving up on the feed socket: connects that keep
 * closing before `open` (a refused upgrade, e.g. the feed's reader cap, looks
 * like close 1006) or keep being closed with 1008 fall back to polling after
 * `MAX_FAILED_CONNECTS` in a row, and a connect that opens resets the count.
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
import type { LogLineContract } from "@scarn/api/frontend-contracts";
import {
  MAX_FAILED_CONNECTS,
  startTaskRunLogFeed,
  type TaskRunLogFeed,
} from "./task-run-log-feed";

const taskRunId = "019e9a92-b432-73e8-9341-3519156fa699";

const logLine = (seq: number): LogLineContract => ({
  seq,
  stream: "worker",
  ts: "2026-10-04T18:17:35.539Z",
  content: `line ${String(seq)}`,
  level: "info",
});

const getLogsMock = mock(() =>
  Promise.resolve({
    data: { lines: [logLine(1)], nextOffset: 1, complete: false },
    error: null,
  }),
);
const getTokenMock = mock(() =>
  Promise.resolve({
    data: { url: "wss://feed.example/task-runs/abc/ws", token: "read-token" },
    error: null,
  }),
);

const apiClient = {
  api: {
    "task-runs": () => ({
      logs: Object.assign(
        { get: getLogsMock },
        {
          archive: {
            get: mock(() => Promise.resolve({ data: {}, error: null })),
          },
        },
      ),
      "log-feed-token": { get: getTokenMock },
    }),
  },
} as unknown as Parameters<typeof startTaskRunLogFeed>[0]["apiClient"];

class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;

  constructor(readonly url: URL) {
    super();
    FakeWebSocket.instances.push(this);
  }

  send() {}

  close() {
    this.readyState = 3;
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  drop(code = 1006) {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code }));
  }
}

const latestSocket = () => {
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error("no socket opened");
  return socket;
};

const flush = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

const closeAndWait = async (socket: FakeWebSocket, code?: number) => {
  socket.drop(code);
  jest.advanceTimersByTime(30_000);
  await flush();
};

describe("startTaskRunLogFeed failed connects", () => {
  const originalWebSocket = globalThis.WebSocket;
  let feed: TaskRunLogFeed | null = null;

  const start = async () => {
    feed = startTaskRunLogFeed({
      apiClient,
      taskRunId,
      live: true,
      onArchived: () => {},
    });
    await flush();
    return feed;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    FakeWebSocket.instances = [];
    getLogsMock.mockClear();
    getTokenMock.mockClear();
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    feed?.dispose();
    feed = null;
    jest.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
  });

  test("falls back to polling after repeated connects that close before opening", async () => {
    const started = await start();

    for (let attempt = 1; attempt <= MAX_FAILED_CONNECTS; attempt += 1) {
      expect(FakeWebSocket.instances).toHaveLength(attempt);
      expect(getLogsMock).not.toHaveBeenCalled();
      await closeAndWait(latestSocket());
    }

    expect(FakeWebSocket.instances).toHaveLength(MAX_FAILED_CONNECTS);
    expect(getLogsMock).toHaveBeenCalled();
    expect(started.getState().lines).toEqual([logLine(1)]);
  });

  test("falls back to polling after repeated 1008 closes", async () => {
    const started = await start();

    for (let attempt = 1; attempt <= MAX_FAILED_CONNECTS; attempt += 1) {
      expect(getLogsMock).not.toHaveBeenCalled();
      latestSocket().open();
      await closeAndWait(latestSocket(), 1008);
    }

    expect(FakeWebSocket.instances).toHaveLength(MAX_FAILED_CONNECTS);
    expect(getLogsMock).toHaveBeenCalled();
    expect(started.getState().lines).toEqual([logLine(1)]);
  });

  test("a connect that opens resets the count", async () => {
    await start();

    for (let attempt = 1; attempt < MAX_FAILED_CONNECTS; attempt += 1) {
      await closeAndWait(latestSocket());
    }
    latestSocket().open();
    await closeAndWait(latestSocket());
    for (let attempt = 1; attempt < MAX_FAILED_CONNECTS; attempt += 1) {
      await closeAndWait(latestSocket());
    }

    expect(FakeWebSocket.instances).toHaveLength(2 * MAX_FAILED_CONNECTS);
    expect(getLogsMock).not.toHaveBeenCalled();
  });
});

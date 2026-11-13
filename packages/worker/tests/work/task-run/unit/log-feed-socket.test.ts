/**
 * `createLogFeedSocket` against an in-memory socket: acks resolve appends,
 * nacks/timeouts/closes reject them, the token is refreshed before expiry and
 * after a 4001, and the socket gives up when the feed is sealed or the token
 * route says the feed is unavailable.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import type { LogFeedToken } from "../../../../src/work/task-run/contracts/socket-token-types";
import {
  createLogFeedSocket,
  type LogFeedSocket,
  type LogFeedSocketOptions,
} from "../../../../src/work/task-run/infra/log-feed-socket";
import {
  createFakeSocketFactory,
  hourFromNow,
  waitFor,
} from "./helpers/fake-log-feed-socket";

const feedUrl = "wss://feed.example/task-runs/run-1/ws";

const line = (seq: number) => ({
  seq,
  stream: "worker" as const,
  ts: new Date(0).toISOString(),
  content: `line ${String(seq)}`,
  level: "info" as const,
});

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the promise to reject");
}

let feed: LogFeedSocket | null = null;

afterEach(() => {
  feed?.stop();
  feed = null;
});

function startFeed(
  overrides: Partial<LogFeedSocketOptions> = {},
  token: LogFeedToken = {
    url: feedUrl,
    token: "token-1",
    expiresAt: hourFromNow(),
  },
) {
  const factory = createFakeSocketFactory();
  let refreshes = 0;
  const refreshToken = vi.fn(() => {
    refreshes += 1;
    return Promise.resolve<LogFeedToken | null>({
      url: feedUrl,
      token: `token-${String(refreshes + 1)}`,
      expiresAt: hourFromNow(),
    });
  });
  feed = createLogFeedSocket({
    taskRunId: "run-1",
    token,
    refreshToken,
    createSocket: factory.createSocket,
    random: () => 0,
    minBackoffMs: 5,
    maxBackoffMs: 10,
    ...overrides,
  });
  feed.start();
  return { feed, sockets: factory.sockets, refreshToken };
}

describe("log feed socket", () => {
  test("connects with the write token and resolves an append on its ack", async () => {
    const { feed, sockets } = startFeed();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.url).toBe(`${feedUrl}?token=token-1`);
    expect(feed.isConnected()).toBe(false);
    expect(await rejection(feed.append([line(1)]))).toContain("not connected");

    sockets[0]?.open();
    expect(feed.isConnected()).toBe(true);
    const appended = feed.append([line(1), line(2)]);
    expect(sockets[0]?.appends).toEqual([
      { t: "append", id: 1, lines: [line(1), line(2)] },
    ]);
    sockets[0]?.receive({ t: "ack", id: 99, nextOffset: 50 });
    sockets[0]?.receive({ t: "ack", id: 1, nextOffset: 2 });
    expect(await appended).toEqual({ nextOffset: 2 });
  });

  test("rejects an append on nack and on ack timeout", async () => {
    const { feed, sockets } = startFeed({ ackTimeoutMs: 20 });
    sockets[0]?.open();

    const nacked = feed.append([line(1)]);
    sockets[0]?.receive({ t: "nack", id: 1, code: "too-large" });
    expect(await rejection(nacked)).toContain("too-large");

    expect(await rejection(feed.append([line(1)]))).toContain("timed out");
    expect(feed.isConnected()).toBe(true);
  });

  test("rejects in-flight appends when the socket drops, then reconnects", async () => {
    const { feed, sockets, refreshToken } = startFeed();
    sockets[0]?.open();

    const inFlight = feed.append([line(1)]);
    sockets[0]?.serverClose(1006);
    expect(await rejection(inFlight)).toContain("closed (1006)");
    expect(feed.isConnected()).toBe(false);

    await waitFor(() => sockets.length === 2);
    expect(refreshToken).not.toHaveBeenCalled();
    expect(sockets[1]?.url).toBe(`${feedUrl}?token=token-1`);
    sockets[1]?.open();
    expect(feed.isConnected()).toBe(true);
  });

  test("refreshes the token and reconnects after a 4001 close", async () => {
    const { feed, sockets, refreshToken } = startFeed();
    sockets[0]?.open();

    sockets[0]?.serverClose(4001);
    await waitFor(() => sockets.length === 2);
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(sockets[1]?.url).toBe(`${feedUrl}?token=token-2`);
    sockets[1]?.open();
    expect(feed.isConnected()).toBe(true);
  });

  test("refreshes before expiry, lets the old socket finish its append, and ignores its 4002", async () => {
    const { feed, sockets, refreshToken } = startFeed(
      { refreshLeadMs: 120_000, minRefreshDelayMs: 20 },
      {
        url: feedUrl,
        token: "token-1",
        expiresAt: new Date(Date.now() + 121_000).toISOString(),
      },
    );
    sockets[0]?.open();
    const onOldSocket = feed.append([line(1)]);

    await waitFor(() => sockets.length === 2);
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(sockets[1]?.url).toBe(`${feedUrl}?token=token-2`);
    expect(feed.isConnected()).toBe(false);

    sockets[0]?.receive({ t: "ack", id: 1, nextOffset: 1 });
    expect(await onOldSocket).toEqual({ nextOffset: 1 });
    expect(sockets[0]?.closedWith).not.toBeNull();

    sockets[1]?.open();
    sockets[0]?.serverClose(4002);
    expect(feed.isConnected()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sockets).toHaveLength(2);
  });

  test("gives up for good when the token route says the feed is unavailable", async () => {
    const refreshToken = vi.fn(() => Promise.resolve(null));
    const { feed, sockets } = startFeed({ refreshToken });
    sockets[0]?.open();
    sockets[0]?.serverClose(4001);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);
    expect(feed.isConnected()).toBe(false);
  });

  test("gives up for good when the feed is sealed", async () => {
    const { feed, sockets } = startFeed();
    sockets[0]?.open();
    const inFlight = feed.append([line(1)]);
    sockets[0]?.receive({ t: "sealed" });

    expect(await rejection(inFlight)).toContain("stopped");
    sockets[0]?.serverClose(1000);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sockets).toHaveLength(1);
    expect(feed.isConnected()).toBe(false);
  });

  test("stop rejects pending appends and closes the socket", async () => {
    const { feed, sockets } = startFeed();
    sockets[0]?.open();
    const inFlight = feed.append([line(1)]);

    feed.stop();
    expect(await rejection(inFlight)).toContain("stopped");
    expect(sockets[0]?.closedWith).toEqual({ code: 1000 });
    expect(feed.isConnected()).toBe(false);
  });
});

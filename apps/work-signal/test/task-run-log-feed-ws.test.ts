import { signLogFeedToken } from "@scarn/core/tasks/task-log/domain/log-feed-token";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { LogLine } from "../src/log-lines";
import {
  CLOSE_POLICY_VIOLATION,
  CLOSE_WRITER_REPLACED,
  MAX_APPENDS_PER_WINDOW,
  MAX_READERS,
  type TaskRunLogFeed,
} from "../src/task-run-log-feed";
import {
  acceptTestSocket,
  nowSeconds,
  randomIp,
  type TestSocket,
} from "./helpers";

type Scope = "write" | "read";

function line(seq: number): LogLine {
  return {
    seq,
    stream: "worker",
    ts: new Date(Date.UTC(2026, 10, 12, 0, 0, seq)).toISOString(),
    content: `line ${String(seq)}`,
    level: "info",
  };
}

function lines(from: number, to: number): LogLine[] {
  return Array.from({ length: to - from + 1 }, (_, i) => line(from + i));
}

function feedStub(taskRunId: string) {
  return env.TASK_RUN_LOG_FEED.get(env.TASK_RUN_LOG_FEED.idFromName(taskRunId));
}

function feedToken(
  taskRunId: string,
  scope: Scope,
  exp = nowSeconds() + 900,
): Promise<string> {
  return signLogFeedToken(
    { tid: taskRunId, pid: "project-1", oid: "org-1", scope, exp },
    env.LOG_FEED_TOKEN_SECRET,
  );
}

function wsRequest(
  taskRunId: string,
  token: string,
  from?: number,
): Promise<Response> {
  const query = new URLSearchParams({ token });
  if (from !== undefined) query.set("from", String(from));
  return exports.default.fetch(
    `http://work-signal/task-runs/${taskRunId}/ws?${query.toString()}`,
    { headers: { Upgrade: "websocket", "cf-connecting-ip": randomIp() } },
  );
}

interface FeedSocket extends TestSocket {
  closed: Promise<number>;
  next(): Promise<unknown>;
}

async function connect(
  taskRunId: string,
  scope: Scope,
  from?: number,
): Promise<FeedSocket> {
  const response = await wsRequest(
    taskRunId,
    await feedToken(taskRunId, scope),
    from,
  );
  const socket = acceptTestSocket(response);
  const closed = new Promise<number>((resolve) => {
    socket.socket.addEventListener("close", (event) => {
      resolve(event.code);
    });
  });
  return {
    ...socket,
    closed,
    next: async () => JSON.parse(await socket.nextMessage()) as unknown,
  };
}

function sendAppend(writer: FeedSocket, id: number, batch: LogLine[]): void {
  writer.socket.send(JSON.stringify({ t: "append", id, lines: batch }));
}

function tags(taskRunId: string): Promise<string[][]> {
  return runInDurableObject(
    feedStub(taskRunId),
    (_instance: TaskRunLogFeed, state) =>
      state.getWebSockets().map((socket) => state.getTags(socket)),
  );
}

describe("log feed WebSocket", () => {
  it("acks a writer's append and pushes the stored lines to a connected reader", async () => {
    const taskRunId = "ws-live";
    const reader = await connect(taskRunId, "read");
    expect(await reader.next()).toEqual({ t: "caught-up", nextOffset: 0 });
    const writer = await connect(taskRunId, "write");

    sendAppend(writer, 1, lines(1, 3));
    expect(await writer.next()).toEqual({ t: "ack", id: 1, nextOffset: 3 });
    expect(await reader.next()).toEqual({ t: "lines", lines: lines(1, 3) });

    sendAppend(writer, 2, lines(2, 5));
    expect(await writer.next()).toEqual({ t: "ack", id: 2, nextOffset: 5 });
    expect(await reader.next()).toEqual({ t: "lines", lines: lines(4, 5) });

    expect((await tags(taskRunId)).sort()).toEqual([["reader"], ["writer"]]);
  });

  it("catches a late reader up on every batch in order without duplicates", async () => {
    const taskRunId = "ws-catch-up";
    const writer = await connect(taskRunId, "write");
    sendAppend(writer, 1, lines(1, 3));
    sendAppend(writer, 2, lines(2, 6));
    sendAppend(writer, 3, lines(7, 9));
    for (const id of [1, 2, 3]) {
      expect(await writer.next()).toMatchObject({ t: "ack", id });
    }

    const reader = await connect(taskRunId, "read", 0);
    const received: LogLine[] = [];
    for (;;) {
      const message = (await reader.next()) as {
        t: string;
        lines?: LogLine[];
        nextOffset?: number;
      };
      if (message.t === "caught-up") {
        expect(message.nextOffset).toBe(9);
        break;
      }
      expect(message.t).toBe("lines");
      received.push(...(message.lines ?? []));
    }
    expect(received).toEqual(lines(1, 9));
  });

  it("starts a reader's catch-up after its from cursor", async () => {
    const taskRunId = "ws-from";
    await feedStub(taskRunId).append(lines(1, 5));
    const reader = await connect(taskRunId, "read", 3);
    expect(await reader.next()).toEqual({ t: "lines", lines: lines(4, 5) });
    expect(await reader.next()).toEqual({ t: "caught-up", nextOffset: 5 });
  });

  it("pushes lines appended through the internal route to readers", async () => {
    const taskRunId = "ws-internal-append";
    const reader = await connect(taskRunId, "read");
    await reader.next();
    await feedStub(taskRunId).append(lines(1, 2));
    expect(await reader.next()).toEqual({ t: "lines", lines: lines(1, 2) });
  });

  it("tells every socket when the feed is sealed and closes the writer", async () => {
    const taskRunId = "ws-sealed";
    const reader = await connect(taskRunId, "read");
    await reader.next();
    const writer = await connect(taskRunId, "write");

    await feedStub(taskRunId).seal();
    expect(await reader.next()).toEqual({ t: "sealed" });
    expect(await writer.next()).toEqual({ t: "sealed" });
    expect(await writer.closed).toBe(1000);

    const late = await connect(taskRunId, "read");
    expect(await late.next()).toEqual({ t: "caught-up", nextOffset: 0 });
    expect(await late.next()).toEqual({ t: "sealed" });

    const lateWriter = await connect(taskRunId, "write");
    expect(await lateWriter.next()).toEqual({ t: "sealed" });
    expect(await lateWriter.closed).toBe(1000);
  });

  it("closes a reader that sends anything but ping with 1008 and no nack", async () => {
    const taskRunId = "ws-reader-message";
    const reader = await connect(taskRunId, "read");
    await reader.next();
    reader.socket.send("x");
    expect(await reader.closed).toBe(CLOSE_POLICY_VIOLATION);
    expect(reader.messages).toEqual([
      JSON.stringify({ t: "caught-up", nextOffset: 0 }),
    ]);
  });

  it("closes a reader that sends an append without storing it", async () => {
    const taskRunId = "ws-reader-append";
    const reader = await connect(taskRunId, "read");
    await reader.next();
    reader.socket.send(
      JSON.stringify({ t: "append", id: 7, lines: lines(1, 1) }),
    );
    expect(await reader.closed).toBe(CLOSE_POLICY_VIOLATION);
    expect(await feedStub(taskRunId).readAll()).toEqual([]);
  });

  it("refuses a reader over the cap with 429 but still admits a writer", async () => {
    const taskRunId = "ws-reader-cap";
    const token = await feedToken(taskRunId, "read");
    const readers: FeedSocket[] = [];
    for (let i = 0; i < MAX_READERS; i++) {
      readers.push(await connect(taskRunId, "read"));
    }
    const refused = await wsRequest(taskRunId, token);
    expect(refused.status).toBe(429);
    expect(refused.webSocket).toBeNull();

    const writer = await connect(taskRunId, "write");
    sendAppend(writer, 1, lines(1, 1));
    expect(await writer.next()).toEqual({ t: "ack", id: 1, nextOffset: 1 });

    readers[0]?.socket.close(1000, "done");
    await expect
      .poll(async () => (await wsRequest(taskRunId, token)).status)
      .toBe(101);
  });

  it("nacks malformed and rejected appends", async () => {
    const taskRunId = "ws-nack";
    const writer = await connect(taskRunId, "write");
    writer.socket.send("not json");
    expect(await writer.next()).toEqual({
      t: "nack",
      id: null,
      code: "bad-request",
    });
    writer.socket.send(JSON.stringify({ t: "append", id: 2, lines: [{}] }));
    expect(await writer.next()).toEqual({
      t: "nack",
      id: 2,
      code: "bad-request",
    });
    sendAppend(writer, 3, lines(1, 1001));
    expect(await writer.next()).toEqual({
      t: "nack",
      id: 3,
      code: "too-many-lines",
    });
  });

  it("closes a writer with 1008 on its third offending nack within a minute", async () => {
    const taskRunId = "ws-offences";
    const feed = feedStub(taskRunId);
    for (let seq = 1; seq <= MAX_APPENDS_PER_WINDOW; seq++) {
      await feed.append([line(seq)]);
    }
    const writer = await connect(taskRunId, "write");
    const over = MAX_APPENDS_PER_WINDOW + 1;
    for (const id of [1, 2]) {
      sendAppend(writer, id, [line(over)]);
      expect(await writer.next()).toEqual({
        t: "nack",
        id,
        code: "rate-limited",
      });
    }
    await evictDurableObject(feed);
    sendAppend(writer, 3, [line(over)]);
    expect(await writer.next()).toEqual({
      t: "nack",
      id: 3,
      code: "rate-limited",
    });
    expect(await writer.closed).toBe(CLOSE_POLICY_VIOLATION);
  });

  it("closes the previous writer when a new one connects", async () => {
    const taskRunId = "ws-two-writers";
    const first = await connect(taskRunId, "write");
    const second = await connect(taskRunId, "write");
    expect(await first.closed).toBe(CLOSE_WRITER_REPLACED);
    sendAppend(second, 1, lines(1, 1));
    expect(await second.next()).toEqual({ t: "ack", id: 1, nextOffset: 1 });
  });

  it("answers ping with pong and keeps pushing after eviction", async () => {
    const taskRunId = "ws-hibernating";
    const reader = await connect(taskRunId, "read");
    await reader.next();
    reader.socket.send("ping");
    expect(await reader.nextMessage()).toBe("pong");

    await evictDurableObject(feedStub(taskRunId));
    const writer = await connect(taskRunId, "write");
    sendAppend(writer, 1, lines(1, 1));
    expect(await writer.next()).toEqual({ t: "ack", id: 1, nextOffset: 1 });
    expect(await reader.next()).toEqual({ t: "lines", lines: lines(1, 1) });
  });

  it.each([
    ["a malformed token", () => Promise.resolve("not-a-jwt")],
    ["an expired token", () => feedToken("ws-auth", "read", nowSeconds() - 1)],
    ["another task run's token", () => feedToken("ws-other", "write")],
  ])("rejects %s before reaching the Durable Object", async (_, makeToken) => {
    const response = await wsRequest("ws-auth", await makeToken());
    expect(response.status).toBe(401);
    expect(response.webSocket).toBeNull();
  });

  it("rejects an invalid from cursor", async () => {
    const response = await wsRequest(
      "ws-bad-from",
      await feedToken("ws-bad-from", "read"),
      -1,
    );
    expect(response.status).toBe(400);
  });

  it("requires a WebSocket upgrade", async () => {
    const token = await feedToken("ws-no-upgrade", "read");
    const response = await exports.default.fetch(
      `http://work-signal/task-runs/ws-no-upgrade/ws?token=${token}`,
    );
    expect(response.status).toBe(426);
  });
});

import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type LogLine, MAX_BATCH_BYTES } from "../src/log-lines";
import {
  ABANDONED_FEED_TTL_MS,
  APPEND_WINDOW_MS,
  MAX_APPENDS_PER_WINDOW,
  MAX_FEED_BYTES,
  SEALED_FEED_TTL_MS,
  type TaskRunLogFeed,
} from "../src/task-run-log-feed";

function line(seq: number, content = `line ${String(seq)}`): LogLine {
  return {
    seq,
    stream: "worker",
    ts: new Date(Date.UTC(2026, 10, 12, 0, 0, seq)).toISOString(),
    content,
    level: "info",
  };
}

function lines(from: number, to: number): LogLine[] {
  return Array.from({ length: to - from + 1 }, (_, i) => line(from + i));
}

function feedStub(taskRunId: string) {
  return env.TASK_RUN_LOG_FEED.get(env.TASK_RUN_LOG_FEED.idFromName(taskRunId));
}

function internal(
  taskRunId: string,
  route: string,
  init: RequestInit & { secret?: string } = {},
): Promise<Response> {
  const { secret = env.LOG_FEED_INTERNAL_SECRET, ...rest } = init;
  return exports.default.fetch(
    `http://work-signal/internal/task-runs/${taskRunId}/${route}`,
    { ...rest, headers: { Authorization: `Bearer ${secret}` } },
  );
}

function appendRequest(
  taskRunId: string,
  body: { lines: object[] },
): Promise<Response> {
  return internal(taskRunId, "append", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function batchCount(taskRunId: string): Promise<number> {
  return runInDurableObject(
    feedStub(taskRunId),
    (_instance: TaskRunLogFeed, state) =>
      state.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM batches")
        .one().n,
  );
}

describe("TaskRunLogFeed storage", () => {
  it("reads back an appended batch", async () => {
    const feed = feedStub("run-read-back");
    expect(await feed.append(lines(1, 3))).toEqual({ nextOffset: 3 });
    expect(await feed.read(0, 100)).toEqual({
      lines: lines(1, 3),
      nextOffset: 3,
    });
    expect(await feed.readAll()).toEqual(lines(1, 3));
  });

  it("drops lines already stored when a batch is re-sent with more lines", async () => {
    const feed = feedStub("run-resend");
    await feed.append(lines(1, 3));
    expect(await feed.append(lines(1, 5))).toEqual({ nextOffset: 5 });
    expect(await feed.append(lines(2, 4))).toEqual({ nextOffset: 5 });
    expect(await feed.readAll()).toEqual(lines(1, 5));
    expect(await batchCount("run-resend")).toBe(2);
  });

  it("starts and stops read cursors inside a batch", async () => {
    const feed = feedStub("run-cursors");
    await feed.append(lines(1, 4));
    await feed.append(lines(5, 8));
    await feed.append([line(10), line(12)]);

    expect(await feed.read(2, 3)).toEqual({
      lines: lines(3, 5),
      nextOffset: 5,
    });
    expect(await feed.read(5, 2)).toEqual({
      lines: lines(6, 7),
      nextOffset: 7,
    });
    expect(await feed.read(10, 100)).toEqual({
      lines: [line(12)],
      nextOffset: 12,
    });
    expect(await feed.read(12, 100)).toEqual({ lines: [], nextOffset: 12 });
  });

  it("reports a zero offset before anything is stored", async () => {
    const feed = feedStub("run-empty");
    expect(await feed.read(0, 10)).toEqual({ lines: [], nextOffset: 0 });
    expect(await feed.append([])).toEqual({ nextOffset: 0 });
    expect(await feed.readAll()).toEqual([]);
  });

  it("rejects appends after sealing but still serves reads", async () => {
    const feed = feedStub("run-sealed");
    await feed.append(lines(1, 2));
    await feed.seal();
    expect(await feed.append(lines(3, 4))).toEqual({ error: "sealed" });
    expect(await feed.readAll()).toEqual(lines(1, 2));
  });

  it("rejects batches over the byte cap", async () => {
    const feed = feedStub("run-too-large");
    const big = line(1, "x".repeat(MAX_BATCH_BYTES));
    expect(await feed.append([big])).toEqual({ error: "too-large" });
    expect(await feed.readAll()).toEqual([]);
  });

  it("writes one row per append", async () => {
    const rowsWritten = await runInDurableObject(
      feedStub("run-rows-written"),
      async (instance: TaskRunLogFeed, state) => {
        await instance.append(lines(1, 2));
        const exec = state.storage.sql.exec.bind(state.storage.sql);
        const written: number[] = [];
        state.storage.sql.exec = ((query: string, ...bindings: unknown[]) => {
          const cursor = exec(query, ...bindings);
          cursor.toArray();
          written.push(cursor.rowsWritten);
          return cursor;
        }) as typeof state.storage.sql.exec;
        await instance.append(lines(3, 50));
        return written;
      },
    );
    expect(rowsWritten).toEqual([1]);
  });
});

/** Appends one single-line batch per call, `count` times from `seq` 1. */
async function fillWindow(taskRunId: string, count: number): Promise<void> {
  const feed = feedStub(taskRunId);
  for (let seq = 1; seq <= count; seq++) {
    expect(await feed.append([line(seq)])).toEqual({ nextOffset: seq });
  }
}

/**
 * Rewrites stored rows, then evicts the object so `load` reseeds its
 * in-memory limits from them. Stands in for the passage of time and for
 * filling the feed without writing {@link MAX_FEED_BYTES}.
 */
async function rewriteBatches(
  taskRunId: string,
  query: string,
  ...bindings: unknown[]
) {
  const feed = feedStub(taskRunId);
  await runInDurableObject(feed, (_instance: TaskRunLogFeed, state) => {
    state.storage.sql.exec(query, ...bindings);
  });
  await evictDurableObject(feed);
}

describe("TaskRunLogFeed limits", () => {
  it(`rate-limits the append after ${String(MAX_APPENDS_PER_WINDOW)} within the window`, async () => {
    const taskRunId = "run-rate-limit";
    const feed = feedStub(taskRunId);
    await fillWindow(taskRunId, MAX_APPENDS_PER_WINDOW);
    const over = MAX_APPENDS_PER_WINDOW + 1;
    expect(await feed.append([line(over)])).toEqual({ error: "rate-limited" });
    expect(await batchCount(taskRunId)).toBe(MAX_APPENDS_PER_WINDOW);
  });

  it("keeps the rate limit across eviction", async () => {
    const taskRunId = "run-rate-limit-evicted";
    const feed = feedStub(taskRunId);
    await fillWindow(taskRunId, MAX_APPENDS_PER_WINDOW);
    await evictDurableObject(feed);
    expect(await feed.append([line(MAX_APPENDS_PER_WINDOW + 1)])).toEqual({
      error: "rate-limited",
    });
  });

  it("accepts appends again once the window has passed", async () => {
    const taskRunId = "run-rate-limit-window";
    const feed = feedStub(taskRunId);
    await fillWindow(taskRunId, MAX_APPENDS_PER_WINDOW);
    await rewriteBatches(
      taskRunId,
      "UPDATE batches SET appended_at = appended_at - ?",
      APPEND_WINDOW_MS + 1,
    );
    const next = MAX_APPENDS_PER_WINDOW + 1;
    expect(await feed.append([line(next)])).toEqual({ nextOffset: next });
    expect(await batchCount(taskRunId)).toBe(next);
  });

  it("does not count an append that stores nothing", async () => {
    const taskRunId = "run-rate-limit-empty";
    const feed = feedStub(taskRunId);
    await fillWindow(taskRunId, MAX_APPENDS_PER_WINDOW - 1);
    expect(await feed.append([line(1)])).toEqual({
      nextOffset: MAX_APPENDS_PER_WINDOW - 1,
    });
    expect(await feed.append([line(MAX_APPENDS_PER_WINDOW)])).toEqual({
      nextOffset: MAX_APPENDS_PER_WINDOW,
    });
  });

  it("rejects an append that would pass the feed byte cap and keeps earlier batches", async () => {
    const taskRunId = "run-feed-full";
    const feed = feedStub(taskRunId);
    await feed.append(lines(1, 3));
    await rewriteBatches(
      taskRunId,
      "UPDATE batches SET total_bytes = ?",
      MAX_FEED_BYTES - 10,
    );
    expect(await feed.append(lines(4, 4))).toEqual({ error: "feed-full" });
    expect(await batchCount(taskRunId)).toBe(1);
    expect(await feed.readAll()).toEqual(lines(1, 3));
  });

  it("tracks stored bytes in each row", async () => {
    const taskRunId = "run-total-bytes";
    const feed = feedStub(taskRunId);
    await feed.append(lines(1, 2));
    await feed.append(lines(3, 3));
    const totals = await runInDurableObject(
      feed,
      (_instance: TaskRunLogFeed, state) =>
        state.storage.sql
          .exec<{ body: string; total_bytes: number }>(
            "SELECT body, total_bytes FROM batches ORDER BY last_seq",
          )
          .toArray(),
    );
    const sizes = totals.map(
      ({ body }) => new TextEncoder().encode(body).length,
    );
    expect(totals.map((row) => row.total_bytes)).toEqual([
      sizes[0],
      (sizes[0] ?? 0) + (sizes[1] ?? 0),
    ]);
  });

  it("adds the limit columns to a feed created with the old schema", async () => {
    const taskRunId = "run-old-schema";
    const feed = feedStub(taskRunId);
    await rewriteBatches(
      taskRunId,
      `DROP TABLE batches;
       CREATE TABLE batches (
         last_seq INTEGER PRIMARY KEY,
         first_seq INTEGER NOT NULL,
         body TEXT NOT NULL
       );
       INSERT INTO batches (last_seq, first_seq, body) VALUES (2, 1, '${JSON.stringify(lines(1, 2))}');`,
    );
    const columns = await runInDurableObject(
      feed,
      (_instance: TaskRunLogFeed, state) =>
        state.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM pragma_table_info('batches')",
          )
          .toArray()
          .map((column) => column.name),
    );
    expect(columns).toEqual(
      expect.arrayContaining(["appended_at", "total_bytes"]),
    );
    expect(await feed.append(lines(3, 3))).toEqual({ nextOffset: 3 });
    expect(await feed.readAll()).toEqual(lines(1, 3));
  });
});

describe("TaskRunLogFeed alarms", () => {
  it("schedules abandonment on the first append only", async () => {
    const feed = feedStub("run-abandon-alarm");
    const before = Date.now();
    await feed.append(lines(1, 1));
    const first = await runInDurableObject(
      feed,
      (_instance: TaskRunLogFeed, state) => state.storage.getAlarm(),
    );
    expect(first).toBeGreaterThanOrEqual(before + ABANDONED_FEED_TTL_MS);
    await feed.append(lines(2, 2));
    const second = await runInDurableObject(
      feed,
      (_instance: TaskRunLogFeed, state) => state.storage.getAlarm(),
    );
    expect(second).toBe(first);
  });

  it("moves the alarm to the sealed TTL on seal", async () => {
    const feed = feedStub("run-seal-alarm");
    await feed.append(lines(1, 1));
    const before = Date.now();
    await feed.seal();
    const alarm = await runInDurableObject(
      feed,
      (_instance: TaskRunLogFeed, state) => state.storage.getAlarm(),
    );
    expect(alarm).toBeGreaterThanOrEqual(before + SEALED_FEED_TTL_MS);
    expect(alarm).toBeLessThan(before + ABANDONED_FEED_TTL_MS);
  });

  it("clears storage when the alarm fires", async () => {
    const feed = feedStub("run-alarm-clears");
    await feed.append(lines(1, 3));
    await feed.seal();
    expect(await runDurableObjectAlarm(feed)).toBe(true);
    expect(await feed.readAll()).toEqual([]);
    expect(await feed.append(lines(1, 1))).toEqual({ nextOffset: 1 });
  });
});

describe("internal routes", () => {
  it("append, read, read-all and seal round-trip as JSON", async () => {
    const taskRunId = "run-internal";
    const appended = await appendRequest(taskRunId, { lines: lines(1, 3) });
    expect(appended.status).toBe(200);
    expect(await appended.json()).toEqual({ nextOffset: 3 });

    const read = await internal(taskRunId, "read?from=1&limit=1");
    expect(await read.json()).toEqual({ lines: [line(2)], nextOffset: 2 });

    const all = await internal(taskRunId, "read-all");
    expect(await all.json()).toEqual({ lines: lines(1, 3) });

    const sealed = await internal(taskRunId, "seal", { method: "POST" });
    expect(sealed.status).toBe(204);

    const rejected = await appendRequest(taskRunId, { lines: lines(4, 4) });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({ error: "sealed" });
  });

  it("returns 401 for a wrong or missing secret", async () => {
    const wrong = await internal("run-auth", "read-all", {
      secret: "not-the-secret",
    });
    expect(wrong.status).toBe(401);
    const missing = await exports.default.fetch(
      "http://work-signal/internal/task-runs/run-auth/read-all",
    );
    expect(missing.status).toBe(401);
  });

  it("returns 400 for malformed lines", async () => {
    const response = await appendRequest("run-malformed", {
      lines: [{ seq: 1, stream: "nope", ts: "x", content: "", level: "info" }],
    });
    expect(response.status).toBe(400);
  });

  it("returns 413 for a batch over the line cap", async () => {
    const response = await appendRequest("run-too-many", {
      lines: lines(1, 1001),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "too-many-lines" });
  });

  it("returns 429 when rate-limited", async () => {
    const taskRunId = "run-internal-rate-limited";
    await fillWindow(taskRunId, MAX_APPENDS_PER_WINDOW);
    const response = await appendRequest(taskRunId, {
      lines: [line(MAX_APPENDS_PER_WINDOW + 1)],
    });
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate-limited" });
  });

  it("returns 413 when the feed is full", async () => {
    const taskRunId = "run-internal-feed-full";
    await feedStub(taskRunId).append(lines(1, 1));
    await rewriteBatches(
      taskRunId,
      "UPDATE batches SET total_bytes = ?",
      MAX_FEED_BYTES,
    );
    const response = await appendRequest(taskRunId, { lines: lines(2, 2) });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "feed-full" });
  });

  it("returns 405 for the wrong method", async () => {
    const response = await internal("run-method", "append");
    expect(response.status).toBe(405);
  });
});

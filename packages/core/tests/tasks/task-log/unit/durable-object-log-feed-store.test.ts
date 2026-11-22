import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { PersistenceError } from "@/lib/errors";
import {
  LogFeedFullError,
  LogFeedRateLimitedError,
  LogFeedSealedError,
} from "@/tasks/task-log/application/log-feed-store";
import {
  DurableObjectLogFeedStore,
  LOG_FEED_MAX_BATCH_BYTES,
  createLogFeedStoreFromEnv,
  resolveLogFeedConnectionFromEnv,
  splitIntoBatches,
} from "@/tasks/task-log/infra/durable-object-log-feed-store";
import { DrizzleLogFeedStore } from "@/tasks/task-log/infra/drizzle-log-feed-store";
import type { AppendLogLineInput } from "@/tasks/task-log/contracts/task-log-contracts";
import { noopLogger } from "@scarn/observability/logging";
import { startFakeLogFeedServer } from "./fake-log-feed-server";

const line = (
  seq: number,
  content = `line ${String(seq)}`,
): AppendLogLineInput => ({
  seq,
  stream: "worker",
  ts: new Date(seq * 1000).toISOString(),
  content,
  level: "info",
});

const errorFrom = async <T>(promise: Promise<T>): Promise<Error | null> => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof Error ? error : null;
  }
};

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => line(from + i));

describe("DurableObjectLogFeedStore", () => {
  const server = startFakeLogFeedServer();

  afterEach(() => {
    server.respondWith(null);
  });

  afterAll(async () => {
    await server.stop();
  });

  test("sends the bearer secret to the run's internal routes", async () => {
    const id = createUuidV7();
    server.received.length = 0;
    const store = server.createStore();

    await store.append(id, [line(1)]);
    await store.read(id, 0, 10);
    await store.readAll(id);
    await store.purge(id);

    expect(
      server.received.map(({ method, path, authorization }) => ({
        method,
        path,
        authorization,
      })),
    ).toEqual([
      {
        method: "POST",
        path: `/internal/task-runs/${id}/append`,
        authorization: "Bearer log-feed-internal-secret",
      },
      {
        method: "GET",
        path: `/internal/task-runs/${id}/read`,
        authorization: "Bearer log-feed-internal-secret",
      },
      {
        method: "GET",
        path: `/internal/task-runs/${id}/read-all`,
        authorization: "Bearer log-feed-internal-secret",
      },
      {
        method: "POST",
        path: `/internal/task-runs/${id}/seal`,
        authorization: "Bearer log-feed-internal-secret",
      },
    ]);
  });

  test("purge seals the feed: appends fail with a 409 error, reads still work", async () => {
    const id = createUuidV7();
    const store = server.createStore();
    await store.append(id, [line(1, "a")]);

    await store.purge(id);
    await store.purge(id);

    expect(server.isSealed(id)).toBe(true);
    expect(await errorFrom(store.append(id, [line(2)]))).toBeInstanceOf(
      LogFeedSealedError,
    );
    expect((await store.readAll(id)).map((l) => l.content)).toEqual(["a"]);
    const sealed = await errorFrom(store.append(id, [line(3)]));
    expect(sealed).toMatchObject({ status: 409, code: "TASK_LOG_FEED_SEALED" });
  });

  test("splits a large batch so each request stays within the DO caps", async () => {
    const id = createUuidV7();
    server.received.length = 0;
    const store = server.createStore();
    const big = "x".repeat(16_000);
    const lines = [
      ...range(1, 1_000),
      ...Array.from({ length: 40 }, (_, i) => line(1_001 + i, big)),
    ];

    const result = await store.append(id, lines);

    expect(result.nextOffset).toBe(1_040);
    expect(await store.readAll(id)).toHaveLength(1_040);
    const appends = server.received.filter((r) => r.path.endsWith("/append"));
    expect(appends.length).toBeGreaterThan(1);
    expect(appends.every((r) => r.lineCount <= 1_000)).toBe(true);
  });

  test("maps a rate-limited append to a 429 error", async () => {
    server.respondWith(() =>
      Response.json({ error: "rate-limited" }, { status: 429 }),
    );
    const store = server.createStore();

    const error = await errorFrom(store.append(createUuidV7(), [line(1)]));

    expect(error).toBeInstanceOf(LogFeedRateLimitedError);
    expect(error).toMatchObject({
      status: 429,
      code: "TASK_LOG_FEED_RATE_LIMITED",
    });
  });

  test("maps a full feed to a 413 error", async () => {
    server.respondWith(() =>
      Response.json({ error: "feed-full" }, { status: 413 }),
    );
    const store = server.createStore();

    const error = await errorFrom(store.append(createUuidV7(), [line(1)]));

    expect(error).toBeInstanceOf(LogFeedFullError);
    expect(error).toMatchObject({ status: 413, code: "TASK_LOG_FEED_FULL" });
  });

  test("treats other 413s as an unavailable feed", async () => {
    server.respondWith(() =>
      Response.json({ error: "too-large" }, { status: 413 }),
    );
    const store = server.createStore();

    const error = await errorFrom(store.append(createUuidV7(), [line(1)]));

    expect(error).toBeInstanceOf(PersistenceError);
    expect(error).toMatchObject({ code: "TASK_LOG_FEED_UNAVAILABLE" });
  });

  test("throws when the DO rejects the secret", async () => {
    const store = server.createStore({ internalSecret: "wrong" });

    expect(await errorFrom(store.readAll(createUuidV7()))).toBeInstanceOf(
      PersistenceError,
    );
  });

  test("throws on a 5xx so the caller keeps the batch", async () => {
    server.respondWith(() => new Response("boom", { status: 503 }));
    const store = server.createStore();

    expect(
      await errorFrom(store.append(createUuidV7(), [line(1)])),
    ).toBeInstanceOf(PersistenceError);
  });

  test("throws on a timeout without waiting for the response", async () => {
    server.respondWith(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve(Response.json({ nextOffset: 1 }));
          }, 2000);
        }),
    );
    const store = server.createStore({ timeoutMs: 50 });

    const startedAt = performance.now();
    const error = await errorFrom(store.append(createUuidV7(), [line(1)]));

    expect(error).toBeInstanceOf(PersistenceError);
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });

  test("throws on a refused connection", async () => {
    const closed = Bun.serve({ port: 0, fetch: () => new Response() });
    const url = closed.url.origin;
    await closed.stop(true);
    const store = new DurableObjectLogFeedStore({
      url,
      internalSecret: "secret",
      logger: noopLogger,
    });

    expect(await errorFrom(store.read(createUuidV7(), 0, 10))).toBeInstanceOf(
      PersistenceError,
    );
  });
});

describe("splitIntoBatches", () => {
  test("sorts, drops duplicate seqs and caps lines per batch", () => {
    const batches = splitIntoBatches([
      ...range(1_001, 2_500),
      ...range(1, 1_000),
      line(5, "duplicate"),
    ]);

    expect(batches.map((batch) => batch.length)).toEqual([1_000, 1_000, 500]);
    expect(batches.flat().map((l) => l.seq)).toEqual(
      range(1, 2_500).map((l) => l.seq),
    );
  });

  test("caps the JSON size of each batch", () => {
    const lines = Array.from({ length: 100 }, (_, i) =>
      line(i + 1, "é".repeat(16_000)),
    );

    const batches = splitIntoBatches(lines);

    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(
        new TextEncoder().encode(JSON.stringify(batch)).byteLength,
      ).toBeLessThanOrEqual(LOG_FEED_MAX_BATCH_BYTES);
    }
  });

  test("yields one empty batch for no lines", () => {
    expect(splitIntoBatches([])).toEqual([[]]);
  });
});

describe("log feed configuration from env", () => {
  const keys = [
    "LOG_FEED_URL",
    "LOG_FEED_INTERNAL_SECRET",
    "LOG_FEED_TOKEN_SECRET",
  ] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  const setEnv = (values: Partial<Record<(typeof keys)[number], string>>) => {
    for (const key of keys) {
      process.env[key] = values[key] ?? "";
    }
  };

  afterEach(() => {
    setEnv(
      Object.fromEntries(
        keys.flatMap((key) =>
          saved[key] === undefined ? [] : [[key, saved[key]]],
        ),
      ),
    );
  });

  test("uses the Durable Object adapter when all three variables are set", () => {
    setEnv({
      LOG_FEED_URL: "https://feed.example.com/",
      LOG_FEED_INTERNAL_SECRET: "internal",
      LOG_FEED_TOKEN_SECRET: "token",
    });

    expect(createLogFeedStoreFromEnv(noopLogger)).toBeInstanceOf(
      DurableObjectLogFeedStore,
    );
    expect(resolveLogFeedConnectionFromEnv()).toEqual({
      url: "https://feed.example.com",
      tokenSecret: "token",
    });
  });

  test("falls back to Postgres when any variable is missing", () => {
    setEnv({
      LOG_FEED_URL: "https://feed.example.com",
      LOG_FEED_INTERNAL_SECRET: "internal",
    });

    expect(createLogFeedStoreFromEnv(noopLogger)).toBeInstanceOf(
      DrizzleLogFeedStore,
    );
    expect(resolveLogFeedConnectionFromEnv()).toBeNull();
  });
});

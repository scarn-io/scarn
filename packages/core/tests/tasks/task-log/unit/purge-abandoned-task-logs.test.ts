import { describe, expect, vi } from "bun:test";
import { concurrentTest, fixedTimeProvider } from "tests/utils";
import {
  ABANDONED_LOG_GRACE_MINUTES,
  purgeAbandonedTaskLogs,
} from "@/tasks/task-log/application/purge-abandoned-task-logs";
import type { LogFeedStore } from "@/tasks/task-log/application/log-feed-store";

type PurgeAbandonedFeedsFn = LogFeedStore["purgeAbandonedFeeds"];

const createLogFeedStore = (
  purgeAbandonedFeeds: ReturnType<typeof vi.fn<PurgeAbandonedFeedsFn>>,
): LogFeedStore => ({
  append: vi.fn(() => Promise.resolve({ nextOffset: 0 })),
  read: vi.fn(() => Promise.resolve({ lines: [], nextOffset: 0 })),
  readAll: vi.fn(() => Promise.resolve([])),
  purge: vi.fn(() => Promise.resolve()),
  purgeAbandonedFeeds,
});

// The use case opens its own transaction via getDb() when no dbExecutor is
// supplied. Passing an executor that is ALREADY a transaction (no `transaction`
// method) makes it reuse the executor directly, keeping these pure unit tests
// database-free. The feed store is fully mocked, so the executor is never used.
const fakeExecutor = {} as never;

// Returns a mock that yields the given per-batch results in order, then zeros.
const batchedMock = (
  batches: { stepsPurged: number; linesPurged: number }[],
): ReturnType<typeof vi.fn<PurgeAbandonedFeedsFn>> => {
  let call = 0;
  return vi.fn<PurgeAbandonedFeedsFn>(() =>
    Promise.resolve(batches[call++] ?? { stepsPurged: 0, linesPurged: 0 }),
  );
};

describe("purgeAbandonedTaskLogs", () => {
  concurrentTest(
    "applies the grace-window cutoff and aggregates a single batch",
    async () => {
      const now = new Date("2026-05-01T12:00:00.000Z");
      const purgeAbandonedFeeds = batchedMock([
        { stepsPurged: 3, linesPurged: 42 },
        { stepsPurged: 0, linesPurged: 0 },
      ]);
      const logFeedStore = createLogFeedStore(purgeAbandonedFeeds);

      const result = await purgeAbandonedTaskLogs({
        logFeedStore,
        timeProvider: fixedTimeProvider(now),
        dbExecutor: fakeExecutor,
      });

      // First call returns 3, second returns 0 -> stop after two calls.
      expect(purgeAbandonedFeeds).toHaveBeenCalledTimes(2);
      const olderThan = purgeAbandonedFeeds.mock.calls[0]?.[0];
      expect(olderThan).toEqual(
        new Date(now.getTime() - ABANDONED_LOG_GRACE_MINUTES * 60 * 1_000),
      );
      expect(result).toEqual({ stepsPurged: 3, linesPurged: 42 });
    },
  );

  concurrentTest("loops batches until a batch reports no progress", async () => {
    const now = new Date("2026-05-01T12:00:00.000Z");
    const purgeAbandonedFeeds = batchedMock([
      { stepsPurged: 2, linesPurged: 20 },
      { stepsPurged: 2, linesPurged: 15 },
      { stepsPurged: 0, linesPurged: 0 },
    ]);
    const logFeedStore = createLogFeedStore(purgeAbandonedFeeds);

    const result = await purgeAbandonedTaskLogs({
      logFeedStore,
      timeProvider: fixedTimeProvider(now),
      dbExecutor: fakeExecutor,
    });

    expect(purgeAbandonedFeeds).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ stepsPurged: 4, linesPurged: 35 });
  });

  concurrentTest("stops at the batch cap even if steps remain", async () => {
    const now = new Date("2026-05-01T12:00:00.000Z");
    const purgeAbandonedFeeds = vi.fn<PurgeAbandonedFeedsFn>(() =>
      Promise.resolve({ stepsPurged: 1, linesPurged: 1 }),
    );
    const logFeedStore = createLogFeedStore(purgeAbandonedFeeds);

    const result = await purgeAbandonedTaskLogs({
      logFeedStore,
      timeProvider: fixedTimeProvider(now),
      maxBatches: 3,
      dbExecutor: fakeExecutor,
    });

    expect(purgeAbandonedFeeds).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ stepsPurged: 3, linesPurged: 3 });
  });

  concurrentTest("passes the configured batch size through", async () => {
    const now = new Date("2026-05-01T12:00:00.000Z");
    const purgeAbandonedFeeds = vi.fn<PurgeAbandonedFeedsFn>(() =>
      Promise.resolve({ stepsPurged: 0, linesPurged: 0 }),
    );
    const logFeedStore = createLogFeedStore(purgeAbandonedFeeds);

    await purgeAbandonedTaskLogs({
      logFeedStore,
      timeProvider: fixedTimeProvider(now),
      maxTasksPerBatch: 7,
      dbExecutor: fakeExecutor,
    });

    expect(purgeAbandonedFeeds.mock.calls[0]?.[1]).toBe(7);
  });
});

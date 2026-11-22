import { afterAll, describe, expect } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { concurrentTest } from "tests/utils";
import { InMemoryLogFeedStore } from "@/tasks/task-log/infra/in-memory-log-feed-store";
import type { LogFeedStore } from "@/tasks/task-log/application/log-feed-store";
import type { AppendLogLineInput } from "@/tasks/task-log/contracts/task-log-contracts";
import { startFakeLogFeedServer } from "./fake-log-feed-server";

const line = (seq: number, content: string): AppendLogLineInput => ({
  seq,
  stream: "worker",
  ts: new Date(seq * 1000).toISOString(),
  content,
  level: "info",
});

const fakeServer = startFakeLogFeedServer();

afterAll(async () => {
  await fakeServer.stop();
});

const adapters: [string, () => LogFeedStore][] = [
  ["InMemoryLogFeedStore", () => new InMemoryLogFeedStore()],
  ["DurableObjectLogFeedStore", () => fakeServer.createStore()],
];

describe.each(adapters)("%s", (_name, createStore) => {
  concurrentTest("append returns the highest seq as nextOffset", async () => {
    const store = createStore();
    const id = createUuidV7();

    const result = await store.append(id, [line(1, "a"), line(2, "b")]);

    expect(result.nextOffset).toBe(2);
  });

  concurrentTest(
    "read with from=0 returns all lines after the exclusive cursor",
    async () => {
      const store = createStore();
      const id = createUuidV7();
      await store.append(id, [line(1, "a"), line(2, "b"), line(3, "c")]);

      const page = await store.read(id, 0, 10);
      expect(page.lines.map((l) => l.content)).toEqual(["a", "b", "c"]);
      expect(page.nextOffset).toBe(3);

      const next = await store.read(id, 3, 10);
      expect(next.lines).toEqual([]);
      expect(next.nextOffset).toBe(3);
    },
  );

  concurrentTest(
    "read respects the limit and advances the cursor",
    async () => {
      const store = createStore();
      const id = createUuidV7();
      await store.append(id, [line(1, "a"), line(2, "b"), line(3, "c")]);

      const page = await store.read(id, 0, 2);
      expect(page.lines.map((l) => l.content)).toEqual(["a", "b"]);
      expect(page.nextOffset).toBe(2);
    },
  );

  concurrentTest("append is idempotent on (taskRunId, seq)", async () => {
    const store = createStore();
    const id = createUuidV7();
    await store.append(id, [line(1, "first")]);
    const retried = await store.append(id, [line(1, "duplicate-ignored")]);

    const all = await store.readAll(id);
    expect(all).toHaveLength(1);
    expect(all[0]?.content).toBe("first");
    expect(retried.nextOffset).toBe(1);
  });

  concurrentTest(
    "a retried batch with new lines appended stores only the new lines",
    async () => {
      const store = createStore();
      const id = createUuidV7();
      await store.append(id, [line(1, "a"), line(2, "b")]);

      const result = await store.append(id, [
        line(1, "a"),
        line(2, "b"),
        line(3, "c"),
      ]);

      expect(result.nextOffset).toBe(3);
      expect((await store.readAll(id)).map((l) => l.content)).toEqual([
        "a",
        "b",
        "c",
      ]);
    },
  );

  concurrentTest("feeds are isolated per task run", async () => {
    const store = createStore();
    const first = createUuidV7();
    const second = createUuidV7();
    await store.append(first, [line(1, "first")]);

    expect(await store.readAll(second)).toEqual([]);
  });

  concurrentTest("purgeAbandonedFeeds reports no progress", async () => {
    const store = createStore();

    expect(await store.purgeAbandonedFeeds(new Date(), 100)).toEqual({
      stepsPurged: 0,
      linesPurged: 0,
    });
  });
});

describe("InMemoryLogFeedStore purge", () => {
  concurrentTest("drops all buffered lines", async () => {
    const store = new InMemoryLogFeedStore();
    const id = createUuidV7();
    await store.append(id, [line(1, "a")]);

    await store.purge(id);

    expect(await store.readAll(id)).toEqual([]);
  });
});

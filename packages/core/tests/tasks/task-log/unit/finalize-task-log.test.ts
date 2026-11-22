import { afterAll, describe, expect } from "bun:test";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { concurrentTest } from "tests/utils";
import { InMemoryLogFeedStore } from "@/tasks/task-log/infra/in-memory-log-feed-store";
import { InMemoryObjectStore } from "@/artifacts/infra/in-memory-object-store";
import {
  finalizeTaskLog,
  taskLogArchiveKey,
} from "@/tasks/task-log/application/finalize-task-log";
import type { TaskRunRepo } from "@/tasks/task-run/application/task-run-repo";
import type { Logger } from "@scarn/observability/logging";
import type { LogFeedStore } from "@/tasks/task-log/application/log-feed-store";
import type { ObjectStore } from "@/artifacts/object-store";
import type { OrgRepo } from "@/organizations/organization/application/org-repo";
import type { UsageMeterRepo } from "@/billing/usage-meter/application/usage-meter-repo";
import type { TimeProvider } from "@/lib/time-provider";
import type { DbExecutor } from "@/lib/db/db-executor";
import { startFakeLogFeedServer } from "./fake-log-feed-server";

const fakeRepo = () => {
  const archives = new Map<string, { storeRef: string; sizeBytes: number }>();
  return {
    archives,
    repo: {
      setLogArchive: (
        taskRunId: UuidV7,
        archive: { storeRef: string; sizeBytes: number },
      ) => {
        archives.set(taskRunId, archive);
        return Promise.resolve();
      },
      getLogArchive: (taskRunId: UuidV7) =>
        Promise.resolve(archives.get(taskRunId) ?? null),
    } as unknown as TaskRunRepo,
  };
};

const overCapDeps = () => ({
  orgRepo: {
    findByProjectId: () => Promise.resolve({ id: createUuidV7() }),
  } as unknown as OrgRepo,
  usageMeterRepo: {
    loadOrStart: () =>
      Promise.resolve({ canRecordWrite: () => false, canStore: () => true }),
  } as unknown as UsageMeterRepo,
  timeProvider: { now: () => new Date() } as unknown as TimeProvider,
  dbExecutor: {} as unknown as DbExecutor,
});

const recordingLogger = () => {
  const warnings: unknown[][] = [];
  const errors: unknown[][] = [];
  const logger = {
    warn: (...args: unknown[]) => warnings.push(args),
    error: (...args: unknown[]) => errors.push(args),
  } as unknown as Logger;
  return { logger, warnings, errors };
};

const oneLine = {
  seq: 1,
  stream: "worker",
  ts: new Date(0).toISOString(),
  content: "a",
  level: "info",
} as const;

const fakeServer = startFakeLogFeedServer();

afterAll(async () => {
  await fakeServer.stop();
});

const adapters: [
  string,
  () => LogFeedStore,
  (feed: LogFeedStore, id: UuidV7) => Promise<boolean>,
][] = [
  [
    "InMemoryLogFeedStore",
    () => new InMemoryLogFeedStore(),
    async (feed, id) => (await feed.readAll(id)).length === 0,
  ],
  [
    "DurableObjectLogFeedStore",
    () => fakeServer.createStore(),
    (_feed, id) => Promise.resolve(fakeServer.isSealed(id)),
  ],
];

describe.each(adapters)(
  "finalizeTaskLog with %s",
  (_name, createStore, isPurged) => {
    concurrentTest(
      "writes NDJSON archive, records metadata, and purges the feed",
      async () => {
        const id = createUuidV7();
        const feed = createStore();
        const objectStore = new InMemoryObjectStore();
        const { repo, archives } = fakeRepo();
        await feed.append(id, [
          {
            seq: 1,
            stream: "worker",
            ts: new Date(0).toISOString(),
            content: "a",
            level: "info",
          },
          {
            seq: 2,
            stream: "ai-server",
            ts: new Date(1000).toISOString(),
            content: "b",
            level: "error",
          },
        ]);

        await finalizeTaskLog(id, createUuidV7(), {
          taskRunRepo: repo,
          logFeedStore: feed,
          objectStore,
        });

        const key = taskLogArchiveKey(id);
        const stored = await objectStore.getObject(key);
        expect(stored).not.toBeNull();
        // getObject transparently decompresses, so callers see plaintext NDJSON
        // even though the archive is stored gzip-compressed.
        const text = new TextDecoder().decode(stored?.body);
        const parsed = text
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as { content: string });
        expect(parsed.map((p) => p.content)).toEqual(["a", "b"]);

        expect(archives.get(id)?.storeRef).toBe(key);
        expect(await isPurged(feed, id)).toBe(true);
      },
    );

    concurrentTest(
      "is a no-op but warns when object storage is not configured",
      async () => {
        const id = createUuidV7();
        const feed = createStore();
        const { repo, archives } = fakeRepo();
        await feed.append(id, [
          {
            seq: 1,
            stream: "worker",
            ts: new Date(0).toISOString(),
            content: "a",
            level: "info",
          },
        ]);
        const warnings: unknown[][] = [];
        const logger = {
          warn: (...args: unknown[]) => warnings.push(args),
        } as unknown as Logger;

        await finalizeTaskLog(id, createUuidV7(), {
          taskRunRepo: repo,
          logFeedStore: feed,
          objectStore: null,
          logger,
        });

        // Feed left intact; no archive recorded.
        expect(await feed.readAll(id)).toHaveLength(1);
        expect(await isPurged(feed, id)).toBe(false);
        expect(archives.get(id)).toBeUndefined();
        // A misconfigured environment that archives nothing must be visible.
        expect(warnings).toHaveLength(1);
        expect(warnings[0]?.[1]).toBe(
          "Skipping log archive: object storage not configured",
        );
      },
    );

    concurrentTest(
      "purges the feed and returns false when over the usage cap",
      async () => {
        const id = createUuidV7();
        const feed = createStore();
        const objectStore = new InMemoryObjectStore();
        const { repo, archives } = fakeRepo();
        await feed.append(id, [oneLine]);

        const kept = await finalizeTaskLog(id, createUuidV7(), {
          taskRunRepo: repo,
          logFeedStore: feed,
          objectStore,
          ...overCapDeps(),
        });

        expect(kept).toBe(false);
        expect(await isPurged(feed, id)).toBe(true);
        expect(archives.get(id)).toBeUndefined();
        expect(await objectStore.getObject(taskLogArchiveKey(id))).toBeNull();
      },
    );

    concurrentTest(
      "leaves the feed in place when the archive write fails",
      async () => {
        const id = createUuidV7();
        const feed = createStore();
        const { repo, archives } = fakeRepo();
        await feed.append(id, [oneLine]);
        const objectStore = {
          putObject: () => Promise.reject(new Error("s3 down")),
        } as unknown as ObjectStore;
        const { logger, errors } = recordingLogger();

        const kept = await finalizeTaskLog(id, createUuidV7(), {
          taskRunRepo: repo,
          logFeedStore: feed,
          objectStore,
          logger,
        });

        expect(kept).toBe(false);
        expect(await isPurged(feed, id)).toBe(false);
        expect(await feed.readAll(id)).toHaveLength(1);
        expect(archives.get(id)).toBeUndefined();
        expect(errors).toHaveLength(1);
      },
    );
  },
);

concurrentTest(
  "logs a failed purge over the usage cap and still returns false",
  async () => {
    const id = createUuidV7();
    const feed = new InMemoryLogFeedStore();
    await feed.append(id, [oneLine]);
    feed.purge = () => Promise.reject(new Error("edge down"));
    const { repo } = fakeRepo();
    const { logger, errors } = recordingLogger();

    const kept = await finalizeTaskLog(id, createUuidV7(), {
      taskRunRepo: repo,
      logFeedStore: feed,
      objectStore: new InMemoryObjectStore(),
      logger,
      ...overCapDeps(),
    });

    expect(kept).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[1]).toBe(
      "Failed to purge task log feed after skipping archive",
    );
  },
);

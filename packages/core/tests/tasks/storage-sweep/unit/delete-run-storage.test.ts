import { describe, expect } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import type { ObjectStore } from "@/artifacts/object-store";
import { InMemoryObjectStore } from "@/artifacts/infra/in-memory-object-store";
import { deleteRunStorage } from "@/tasks/storage-sweep/application/delete-run-storage";
import { storageSweepPrefixes } from "@/tasks/storage-sweep/domain/storage-sweep";
import { deriveArtifactObjectKey } from "@/tasks/task-artifact/domain/artifact-object-key";
import { taskLogArchiveKey } from "@/tasks/task-log/application/finalize-task-log";
import { taskRunSessionObjectKey } from "@/tasks/task-run/domain/task-run-session-object-key";
import { concurrentTest } from "tests/utils";

const newRun = () => ({ projectId: createUuidV7(), taskRunId: createUuidV7() });

const runKeys = (run: ReturnType<typeof newRun>) => [
  taskRunSessionObjectKey(run.taskRunId),
  taskLogArchiveKey(run.taskRunId),
  deriveArtifactObjectKey({ ...run, relativeStorePath: "out/report.md" }),
];

describe("storageSweepPrefixes", () => {
  concurrentTest("covers every key the key helpers build", () => {
    const run = newRun();
    const prefixes = storageSweepPrefixes(run);

    expect(prefixes).toEqual([
      `tasks/${run.taskRunId}/`,
      `step-executions/${run.taskRunId}/`,
      `artifacts/${run.projectId}/${run.taskRunId}/`,
    ]);
    for (const key of runKeys(run)) {
      expect(prefixes.some((prefix) => key.startsWith(prefix))).toBe(true);
    }
  });
});

describe("deleteRunStorage", () => {
  concurrentTest(
    "removes all three prefixes of each run and nothing else",
    async () => {
      const store = new InMemoryObjectStore();
      const runs = [newRun(), newRun()];
      const kept = newRun();
      for (const run of [...runs, kept]) {
        for (const key of runKeys(run)) {
          await store.putObject({ key, body: "x" });
        }
      }

      await deleteRunStorage(runs, { objectStore: store });

      for (const run of runs) {
        for (const key of runKeys(run)) {
          expect(await store.getObject(key)).toBeNull();
        }
      }
      for (const key of runKeys(kept)) {
        expect(await store.getObject(key)).not.toBeNull();
      }
    },
  );

  concurrentTest("never throws when the object store fails", async () => {
    const warnings: string[] = [];
    const failingStore: ObjectStore = {
      putObject: () => Promise.resolve({ sizeBytes: 0 }),
      getObject: () => Promise.resolve(null),
      getObjectStream: () => Promise.resolve(null),
      getPresignedGetUrl: () => Promise.resolve(null),
      getPresignedPutUrl: () => Promise.resolve(null),
      deleteObject: () => Promise.resolve(),
      deletePrefix: () => Promise.reject(new Error("simulated S3 outage")),
    };
    const logger = {
      warn: (_fields: object, message: string) => {
        warnings.push(message);
      },
    } as unknown as Parameters<typeof deleteRunStorage>[1]["logger"];

    await deleteRunStorage([newRun()], { objectStore: failingStore, logger });

    expect(warnings).toHaveLength(1);
  });

  concurrentTest("does nothing without an object store", async () => {
    await deleteRunStorage([newRun()], { objectStore: null });
  });
});

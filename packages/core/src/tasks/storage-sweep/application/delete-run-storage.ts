import type { Logger } from "@scarn/observability/logging";
import type { ObjectStore } from "@scarn/core/artifacts/object-store";
import { storageSweepPrefixes, type SweptRun } from "../domain/storage-sweep";

/**
 * Deletes every prefix of one run. Throws on the first failure, after trying
 * every prefix, so a partial sweep is retried as a whole.
 */
export const deleteRunPrefixes = async (
  run: SweptRun,
  objectStore: ObjectStore,
): Promise<void> => {
  const results = await Promise.allSettled(
    storageSweepPrefixes(run).map(
      async (prefix) => await objectStore.deletePrefix(prefix),
    ),
  );
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) {
    throw failure.reason;
  }
};

export type DeleteRunStorageDeps = {
  objectStore: ObjectStore | null;
  logger?: Logger | undefined;
};

/**
 * Delete-time cleanup: call after the transaction that deleted the runs (and
 * scheduled their sweeps) commits. Removes most stored data at once.
 * Best-effort: it never throws; failures are logged and the scheduled sweep
 * retries them.
 */
export const deleteRunStorage = async (
  runs: SweptRun[],
  { objectStore, logger }: DeleteRunStorageDeps,
): Promise<void> => {
  if (!objectStore) {
    return;
  }
  await Promise.all(
    runs.map(async (run) => {
      try {
        await deleteRunPrefixes(run, objectStore);
      } catch (error) {
        logger?.warn(
          { projectId: run.projectId, taskRunId: run.taskRunId, error },
          "Delete-time storage cleanup failed; the scheduled sweep will retry",
        );
      }
    }),
  );
};

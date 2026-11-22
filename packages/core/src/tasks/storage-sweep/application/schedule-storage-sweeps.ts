import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import { STORAGE_SWEEP_DELAY_MS, type SweptRun } from "../domain/storage-sweep";
import type { StorageSweepRepo } from "./storage-sweep-repo";

export type ScheduleStorageSweepsDeps = {
  storageSweepRepo: StorageSweepRepo;
  timeProvider: TimeProvider;
};

/**
 * Schedules a storage sweep for each deleted run. Call it inside the
 * transaction that deletes the runs (`dbExecutor`), so the sweeps exist exactly
 * when the runs are gone. The sweep is due {@link STORAGE_SWEEP_DELAY_MS} after
 * the delete, once already-issued upload URLs have expired.
 */
export const scheduleStorageSweeps = async (
  runs: SweptRun[],
  deps: ScheduleStorageSweepsDeps,
  dbExecutor: DbExecutor,
): Promise<void> => {
  const now = deps.timeProvider.now();
  await deps.storageSweepRepo.schedule(
    runs,
    {
      notBefore: new Date(now.getTime() + STORAGE_SWEEP_DELAY_MS),
      createdAt: now,
    },
    dbExecutor,
  );
};

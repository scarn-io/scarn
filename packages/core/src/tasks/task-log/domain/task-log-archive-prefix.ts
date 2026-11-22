import { STEP_EXECUTION_ARCHIVE_PREFIX } from "@scarn/core/billing/usage-meter/domain/storage-retention";

/** The prefix holding every object stored for a run's log archive. */
export const taskLogArchivePrefix = (taskRunId: string): string =>
  `${STEP_EXECUTION_ARCHIVE_PREFIX}${taskRunId}/`;

import { TASK_SESSION_PREFIX } from "@scarn/core/billing/usage-meter/domain/storage-retention";

/** Content type the saved-session upload URL is signed for. */
export const TASK_RUN_SESSION_CONTENT_TYPE = "application/json";

/**
 * Where a Task's exported agent session is stored. Derived on the server so a
 * worker can't point a Task at another Task's object.
 */
export const taskRunSessionObjectKey = (taskRunId: string): string =>
  `${taskRunSessionPrefix(taskRunId)}session.json`;

/** The prefix holding every object stored for a run's agent session. */
export const taskRunSessionPrefix = (taskRunId: string): string =>
  `${TASK_SESSION_PREFIX}${taskRunId}/`;

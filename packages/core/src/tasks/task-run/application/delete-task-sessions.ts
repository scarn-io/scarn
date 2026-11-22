import type { Logger } from "@scarn/observability/logging";
import type { ObjectStore } from "@scarn/core/artifacts/object-store";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";

export type SessionCleanupDeps = {
  objectStore?: ObjectStore | null | undefined;
  logger?: Logger | undefined;
};

/**
 * The saved agent sessions (`session_object_key`) of the Tasks that ended in
 * a transaction, collected by `onTaskEnded` for deletion once it commits.
 */
export type EndedTaskSessions = Set<string>;

/**
 * Deletes the saved agent sessions of Tasks that ended: only a waiting Task's
 * latest run is ever restored. Call it after the transaction that ended them
 * commits. Best-effort: failures are logged, and the `tasks/` lifecycle rule
 * removes whatever is left.
 */
export const deleteTaskSessions = async (
  objectKeys: Iterable<string>,
  { objectStore, logger }: SessionCleanupDeps,
): Promise<void> => {
  if (!objectStore) {
    return;
  }
  await Promise.all(
    [...objectKeys].map(async (objectKey) => {
      try {
        await objectStore.deleteObject(objectKey);
      } catch (error) {
        logger?.warn(
          { objectKey, error },
          "Failed to delete a saved agent session",
        );
      }
    }),
  );
};

/**
 * Runs `operation` with the collector for the sessions of Tasks it ends. A
 * caller that passes its own collector (`endedTaskSessions`) deletes them
 * itself; otherwise they are deleted after `operation` returns, when it ran
 * its own transaction (no `dbExecutor`).
 */
export const withTaskSessionCleanup = async <T>(
  deps: SessionCleanupDeps & {
    endedTaskSessions?: EndedTaskSessions | undefined;
    dbExecutor?: DbExecutor | undefined;
  },
  operation: (endedTaskSessions: EndedTaskSessions) => Promise<T>,
): Promise<T> => {
  if (deps.endedTaskSessions) {
    return await operation(deps.endedTaskSessions);
  }
  const endedTaskSessions: EndedTaskSessions = new Set();
  const result = await operation(endedTaskSessions);
  if (!deps.dbExecutor) {
    await deleteTaskSessions(endedTaskSessions, deps);
  }
  return result;
};

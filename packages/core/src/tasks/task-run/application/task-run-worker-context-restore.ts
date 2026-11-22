import type { ObjectStore } from "@scarn/core/artifacts/object-store";
import type { TaskRunWorkerContextContract } from "../contracts/task-run-contracts";
import type { TaskRunEntity } from "../domain/task-run-entity";
import type { TaskRunRepo } from "./task-run-repo";

/**
 * Long enough to outlast workspace preparation (clone, devcontainer build)
 * between fetching the worker context and downloading the session.
 */
const DOWNLOAD_URL_EXPIRES_IN_SECONDS = 3600;

/**
 * Set when the run is a `continuation` of a previous run that saved its
 * session: a hand-over continued by a person, or a wait whose work item is
 * ready. `message` is what the restored session is told next; null when the
 * run isn't a continuation (a retry, rerun or steer starts a fresh session).
 * Null when the export is gone (cleared or past the 30-day window) or the
 * store can't presign, including when presigning throws; the worker then
 * starts a fresh session from the prompt.
 */
export const loadRestoreSession = async ({
  task,
  message,
  taskRunRepo,
  objectStore,
}: {
  task: TaskRunEntity;
  message: string | null;
  taskRunRepo: TaskRunRepo;
  objectStore: ObjectStore | null | undefined;
}): Promise<TaskRunWorkerContextContract["restoreSession"]> => {
  if (
    task.reason !== "continuation" ||
    !task.previousTaskRunId ||
    !objectStore ||
    message === null
  ) {
    return null;
  }
  const previous = await taskRunRepo.load(task.previousTaskRunId);
  if (!previous?.sessionObjectKey) {
    return null;
  }
  const downloadUrl = await objectStore
    .getPresignedGetUrl(
      previous.sessionObjectKey,
      DOWNLOAD_URL_EXPIRES_IN_SECONDS,
    )
    .catch(() => null);
  return downloadUrl ? { downloadUrl, message } : null;
};

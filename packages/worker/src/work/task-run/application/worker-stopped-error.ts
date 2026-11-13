/** Error code reported when the worker stops a run before it finished. */
export const WORKER_STOPPED_ERROR_CODE = "WORKER_STOPPED";

/** The named error a pipeline's `retry`/`catch` matches for a stopped worker. */
export const WORKER_STOPPED_ERROR_NAME = "Scarn.WorkerStopped";

/**
 * Thrown when the run was aborted with the `worker_stopped` reason: the worker
 * is shutting down and gave up the run. Unlike `TaskRunCancelledError`,
 * the server still expects an outcome, so the run is reported as failed with
 * {@link WORKER_STOPPED_ERROR_CODE} once its logs are flushed.
 */
export class WorkerStoppedError extends Error {
  constructor(taskRunId: string) {
    super(`Task run ${taskRunId} was stopped because the worker is stopping.`);
    this.name = "WorkerStoppedError";
  }
}

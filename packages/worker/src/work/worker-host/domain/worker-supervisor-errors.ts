/**
 * Raised when a project is added from a different server than the one the
 * background worker instance is bound to. One instance serves one base URL.
 */
export class WorkerBaseUrlMismatchError extends Error {
  override readonly name = "WorkerBaseUrlMismatchError";

  constructor(
    readonly instance: string,
    readonly expectedBaseUrl: string,
    readonly actualBaseUrl: string,
  ) {
    super(
      `Worker instance ${instance} works for ${expectedBaseUrl}; it cannot add a project from ${actualBaseUrl}.`,
    );
  }
}

/**
 * Raised when a project is added or changed while the background worker is
 * not running: before it started, or once it has begun to stop.
 */
export class WorkerNotRunningError extends Error {
  override readonly name = "WorkerNotRunningError";

  constructor(readonly instance: string) {
    super(`Worker instance ${instance} is not running.`);
  }
}

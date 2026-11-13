import { CliError } from "../../lib/cli-error";

/** Raised by `worker start --foreground` when the instance already has a live worker. */
export class WorkerAlreadyRunningError extends CliError {
  constructor(
    readonly instance: string,
    readonly pid: number | null,
  ) {
    super(
      "worker_already_running",
      pid === null
        ? `Worker instance ${instance} is already running.`
        : `Worker instance ${instance} is already running (pid ${String(pid)}).`,
    );
    this.name = "WorkerAlreadyRunningError";
  }
}

/** Raised when a background worker did not come up. */
export class WorkerStartFailedError extends CliError {
  constructor(message: string) {
    super("worker_start_failed", message);
    this.name = "WorkerStartFailedError";
  }
}

/** Exit code of a `worker` command that needs a running worker and found none. */
export const WORKER_NOT_RUNNING_EXIT_CODE = 3;

/** Raised when a command needs the instance's background worker and none runs. */
export class WorkerNotRunningError extends CliError {
  constructor(readonly instance: string) {
    super("worker_not_running", `Worker instance ${instance} is not running.`, {
      exitCode: WORKER_NOT_RUNNING_EXIT_CODE,
    });
    this.name = "WorkerNotRunningError";
  }
}

/** Raised when the running worker's version or protocol differs from this CLI's. */
export class WorkerVersionMismatchError extends CliError {
  constructor(
    readonly instance: string,
    readonly workerVersion: string,
    readonly cliVersion: string,
  ) {
    super(
      "worker_version_mismatch",
      `The running worker is version ${workerVersion}; this CLI is ${cliVersion}. ` +
        `Run \`${instance} worker stop && ${instance} worker start\`.`,
    );
    this.name = "WorkerVersionMismatchError";
  }
}

/** Raised when the worker's process is alive but its control API does not answer. */
export class WorkerUnresponsiveCliError extends CliError {
  constructor(
    readonly instance: string,
    readonly pid: number,
  ) {
    super(
      "worker_unresponsive",
      `Worker instance ${instance} (pid ${String(pid)}) is running but its control API does not answer.`,
    );
    this.name = "WorkerUnresponsiveCliError";
  }
}

/** Raised when the worker answered a control-API request with an error. */
export class WorkerRequestFailedError extends CliError {
  // eslint-disable-next-line local/no-unknown-parameter-type -- Eden reports an error body as an untyped value
  constructor(what: string, detail: unknown) {
    super("worker_request_failed", `Could not ${what}: ${describe(detail)}`);
    this.name = "WorkerRequestFailedError";
  }
}

// eslint-disable-next-line local/no-unknown-parameter-type -- Eden reports an error body as an untyped value
function describe(detail: unknown): string {
  if (typeof detail === "object" && detail !== null && "message" in detail) {
    return String(detail.message);
  }
  if (detail instanceof Error) return detail.message;
  return typeof detail === "string" ? detail : JSON.stringify(detail);
}

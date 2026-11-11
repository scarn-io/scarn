/**
 * The server no longer recognises this worker's claim on the run: the run is
 * gone (404) or the claim was revoked (409, e.g. the run was cancelled or
 * reassigned). Definitive: the worker stops the agent and writes nothing more,
 * since the server would refuse it anyway.
 */
export class TaskRunCancelledError extends Error {
  constructor(taskRunId: string) {
    super(`Task run ${taskRunId} was cancelled or its claim was revoked.`);
    this.name = "TaskRunCancelledError";
  }
}

const CANCELLED_STATUSES = new Set([404, 409]);

/**
 * Whether a worker API failure means the run is gone or the claim is revoked.
 * The SDK throws `Error(JSON.stringify(problem))`, where the problem details
 * carry the HTTP `status`.
 */
// eslint-disable-next-line local/no-unknown-parameter-type -- narrows a caught value, not a real input boundary
export function isTaskRunCancelledResponse(error: unknown): boolean {
  const message = error instanceof Error ? error.message : null;
  if (!message?.startsWith("{")) return false;
  try {
    const problem: unknown = JSON.parse(message);
    return (
      typeof problem === "object" &&
      problem !== null &&
      "status" in problem &&
      typeof problem.status === "number" &&
      CANCELLED_STATUSES.has(problem.status)
    );
  } catch {
    return false;
  }
}

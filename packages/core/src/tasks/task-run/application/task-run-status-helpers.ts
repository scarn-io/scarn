import type { TaskRunStatus } from "../domain/task-run-entity";

const TERMINAL_STATUSES: ReadonlySet<TaskRunStatus> = new Set([
  "succeeded",
  "failed",
  "timeout",
  "abandoned",
  "cancelled",
  "skipped",
  "yielded",
]);

/**
 * True when the task has reached a state it will not leave. `yielded` is
 * terminal: the answer to its question starts a new Task, the continuation.
 */
export const isTerminalTaskRunStatus = (status: TaskRunStatus): boolean =>
  TERMINAL_STATUSES.has(status);

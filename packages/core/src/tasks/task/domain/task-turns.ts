/**
 * A Task's turns: how many times its agent may hand the conversation to a
 * person (`maxTurns`), and what happens when a yield goes past them.
 */
import { CoreValidationError } from "@scarn/core/lib/errors";
import { TASK_ERROR_NAMES } from "./run-error";
import type { TaskRunState } from "./task-state-for-run";

export const MAX_TURNS_EXCEEDED_ERROR_NAME = TASK_ERROR_NAMES.maxTurnsExceeded;

/** A standalone Task's `maxTurns` when its step definition sets none. */
export const DEFAULT_STANDALONE_MAX_TURNS = 20;

/**
 * How many more times `task` may hand the conversation to a person: its
 * `maxTurns` minus its `continuation` runs. Null for a Task with no turns.
 */
export const turnsLeft = (
  task: { maxTurns: number | null },
  continuationRuns: number,
): number | null =>
  task.maxTurns === null ? null : Math.max(0, task.maxTurns - continuationRuns);

/** `maxTurns`, checked to be null or a non-negative integer. */
export const validMaxTurns = (maxTurns: number | null): number | null => {
  if (maxTurns !== null && (!Number.isInteger(maxTurns) || maxTurns < 0)) {
    throw new CoreValidationError(
      "Task maxTurns must be a non-negative integer",
      "TASK_MAX_TURNS_INVALID",
    );
  }
  return maxTurns;
};

/** The failed state of a Task whose run yielded with no turns left. */
export const maxTurnsExceeded = (
  label: string,
  maxTurns: number | null,
): TaskRunState => ({
  status: "failed",
  resultJson: null,
  errorJson: {
    name: MAX_TURNS_EXCEEDED_ERROR_NAME,
    message: `"${label}" can't hand over more than ${String(maxTurns)} times`,
  },
});

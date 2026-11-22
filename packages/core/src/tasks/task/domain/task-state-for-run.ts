/**
 * The Task state a run's status gives its Task, as `TaskEntity.followRun`
 * applies it.
 */
import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import type { TaskRunEntity } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import { namedRunError } from "./run-error";
import type { TaskStatus } from "./task-entity";

export type TaskRunState = {
  status: TaskStatus;
  resultJson: AnyJsonValue | null;
  errorJson: AnyJsonValue | null;
};

/** The run's own error details, named and described as `namedRunError` says. */
const taskErrorForRun = (run: TaskRunEntity): AnyJsonValue => {
  const details =
    typeof run.errorJson === "object" &&
    run.errorJson !== null &&
    !Array.isArray(run.errorJson)
      ? run.errorJson
      : {};
  return { ...details, ...namedRunError(run) };
};

/** The Task state a run in `run.status` gives its Task; null when it gives none. */
export const taskStateForRun = (run: TaskRunEntity): TaskRunState | null => {
  switch (run.status) {
    case "queued":
    case "running":
      return { status: run.status, resultJson: null, errorJson: null };
    case "yielded":
      return {
        status: "waiting_for_person",
        resultJson: null,
        errorJson: null,
      };
    case "succeeded":
      return {
        status: "succeeded",
        resultJson: run.resultJson,
        errorJson: null,
      };
    case "failed":
    case "timeout":
    case "abandoned":
      return {
        status: "failed",
        resultJson: null,
        errorJson: taskErrorForRun(run),
      };
    case "cancelled":
      return { status: "cancelled", resultJson: null, errorJson: null };
    default:
      return null;
  }
};

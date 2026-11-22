/**
 * The named error a failed run gives its Task, the name a `retry` or `catch`
 * entry matches: a timeout is `Scarn.Timeout`, a lost lease is
 * `Scarn.HeartbeatTimeout`, and any other failure carries the name it was
 * reported with, else `Scarn.StepFailed`.
 */
import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import type { TaskRunStatus } from "@scarn/core/tasks/task-run/domain/task-run-entity";

export const TASK_ERROR_NAMES = {
  stepFailed: "Scarn.StepFailed",
  timeout: "Scarn.Timeout",
  heartbeatTimeout: "Scarn.HeartbeatTimeout",
  maxTurnsExceeded: "Scarn.MaxTurnsExceeded",
  logArchiveFailed: "Scarn.LogArchiveFailed",
  workItemChangesInvalid: "Scarn.WorkItemChangesInvalid",
  workItemNotNative: "Scarn.WorkItemNotNative",
} as const;

export type NamedError = {
  name: string;
  message: string;
  cause?: AnyJsonValue;
};

const field = (value: AnyJsonValue | null, key: string): unknown =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value[key]
    : undefined;

const stringField = (
  value: AnyJsonValue | null,
  key: string,
): string | undefined => {
  const found = field(value, key);
  return typeof found === "string" ? found : undefined;
};

/** The named error of a run that ended `status` with `errorJson`. */
export function namedRunError(run: {
  status: TaskRunStatus;
  errorJson: AnyJsonValue | null;
}): NamedError {
  if (run.status === "timeout") {
    return { name: TASK_ERROR_NAMES.timeout, message: "The step timed out" };
  }
  if (run.status === "abandoned") {
    return {
      name: TASK_ERROR_NAMES.heartbeatTimeout,
      message: "The step stopped sending heartbeats",
    };
  }
  const name =
    stringField(run.errorJson, "name") ?? TASK_ERROR_NAMES.stepFailed;
  const message = stringField(run.errorJson, "message") ?? "The step failed";
  const cause = field(run.errorJson, "cause") as AnyJsonValue | undefined;
  return cause === undefined ? { name, message } : { name, message, cause };
}

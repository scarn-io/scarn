import {
  HEALTH_CHECK_FAILED_ERROR_CODE,
  HEALTH_CHECK_FAILED_ERROR_NAME,
  HealthCheckFailedError,
} from "./health-check-failed-error";
import {
  REPO_CONTEXT_COMMIT_UNAVAILABLE_ERROR_CODE,
  REPO_CONTEXT_COMMIT_UNAVAILABLE_ERROR_NAME,
  RepoContextCommitUnavailableError,
} from "./repo-context-commit-unavailable-error";
import {
  WORKER_STOPPED_ERROR_CODE,
  WORKER_STOPPED_ERROR_NAME,
  WorkerStoppedError,
} from "./worker-stopped-error";

const WORKER_EXECUTION_FAILED_ERROR_CODE = "SCARN_WORKER_EXECUTION_FAILED";
const STEP_FAILED_ERROR_NAME = "Scarn.StepFailed";

type TaskRunFailureInputError =
  | Error
  | { message?: string | undefined }
  | string
  | number
  | boolean
  | null
  | undefined;

function toFailureMessage(error: TaskRunFailureInputError): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    return typeof error.message === "string"
      ? error.message
      : "Unknown failure";
  }

  if (typeof error === "string") {
    return error;
  }

  if (typeof error === "number" || typeof error === "boolean") {
    return String(error);
  }

  return "Unknown failure";
}

function failureIdentity(error: TaskRunFailureInputError): {
  name: string;
  code: string;
} {
  if (error instanceof HealthCheckFailedError) {
    return {
      name: HEALTH_CHECK_FAILED_ERROR_NAME,
      code: HEALTH_CHECK_FAILED_ERROR_CODE,
    };
  }
  if (error instanceof RepoContextCommitUnavailableError) {
    return {
      name: REPO_CONTEXT_COMMIT_UNAVAILABLE_ERROR_NAME,
      code: REPO_CONTEXT_COMMIT_UNAVAILABLE_ERROR_CODE,
    };
  }
  if (error instanceof WorkerStoppedError) {
    return {
      name: WORKER_STOPPED_ERROR_NAME,
      code: WORKER_STOPPED_ERROR_CODE,
    };
  }
  return {
    name: STEP_FAILED_ERROR_NAME,
    code: WORKER_EXECUTION_FAILED_ERROR_CODE,
  };
}

export function buildTaskRunFailurePayload(error: TaskRunFailureInputError) {
  return {
    resultJson: {
      status: "failed",
    },
    errorJson: {
      ...failureIdentity(error),
      message: toFailureMessage(error),
    },
  };
}

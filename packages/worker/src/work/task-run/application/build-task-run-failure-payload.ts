import {
  HEALTH_CHECK_FAILED_ERROR_CODE,
  HEALTH_CHECK_FAILED_ERROR_NAME,
  HealthCheckFailedError,
} from "./health-check-failed-error";

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

export function buildTaskRunFailurePayload(error: TaskRunFailureInputError) {
  const message = toFailureMessage(error);
  const healthCheck = error instanceof HealthCheckFailedError;

  return {
    resultJson: {
      status: "failed",
    },
    errorJson: {
      name: healthCheck
        ? HEALTH_CHECK_FAILED_ERROR_NAME
        : STEP_FAILED_ERROR_NAME,
      code: healthCheck
        ? HEALTH_CHECK_FAILED_ERROR_CODE
        : WORKER_EXECUTION_FAILED_ERROR_CODE,
      message,
    },
  };
}

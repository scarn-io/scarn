import {
  EnvironmentNotFound,
  EnvironmentInvalid,
  BrokenDevcontainerReference,
} from "@scarn/sdk/environment";
import {
  ConnectorMcpCollision,
  ConnectorVarsMissing,
} from "@scarn/sdk/connectors";
import { MissingStepEnvError } from "./resolve-step-env";
import { ProjectSecretsRequestError } from "./resolve-secret-env";
import { RepoBranchNotFoundError } from "./repo-branch-not-found-error";
import { RepoBranchInvalidError } from "./repo-branch-invalid-error";
import {
  HEALTH_CHECK_FAILED_ERROR_CODE,
  HEALTH_CHECK_FAILED_ERROR_NAME,
  HealthCheckFailedError,
} from "./health-check-failed-error";
import {
  CONNECTOR_UNAVAILABLE_ERROR_CODE,
  CONNECTOR_UNAVAILABLE_ERROR_NAME,
  ConnectorUnavailableError,
} from "./connector-unavailable-error";
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
import {
  MANAGED_CONNECTION_AUTHORITY_LOST_ERROR_CODE,
  MANAGED_CONNECTION_AUTHORITY_LOST_ERROR_NAME,
  ManagedAuthorityLostError,
} from "./managed-authority-lost-error";
import {
  MANAGED_CONNECTION_NOT_READY_ERROR_CODE,
  MANAGED_CONNECTION_NOT_READY_ERROR_NAME,
  ManagedConnectionNotReadyError,
} from "./managed-connection-not-ready-error";
import { McpConnectionAuthRejectedError } from "./mcp-connection-auth-rejected-error";
import {
  MCP_CONNECTION_AUTH_INVALID_ERROR_NAME,
  McpConnectionAuthNotRemoteError,
} from "../infra/mcp-server-ref-resolver";
import { McpToolStepError } from "./mcp-tool-step-error";

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
  if (error instanceof ConnectorUnavailableError) {
    return {
      name: CONNECTOR_UNAVAILABLE_ERROR_NAME,
      code: CONNECTOR_UNAVAILABLE_ERROR_CODE,
    };
  }
  if (
    error instanceof EnvironmentNotFound ||
    error instanceof EnvironmentInvalid ||
    error instanceof BrokenDevcontainerReference ||
    error instanceof ConnectorVarsMissing
  ) {
    return { name: `Scarn.${error.kind}`, code: error.code };
  }
  if (error instanceof ConnectorMcpCollision) {
    return { name: "Scarn.EnvironmentInvalid", code: error.code };
  }
  if (
    error instanceof RepoBranchNotFoundError ||
    error instanceof RepoBranchInvalidError
  ) {
    return { name: error.name, code: error.code };
  }
  if (
    error instanceof MissingStepEnvError ||
    error instanceof ProjectSecretsRequestError
  ) {
    return {
      name: "Scarn.EnvironmentUnresolved",
      code: "SCARN_ENVIRONMENT_UNRESOLVED",
    };
  }
  if (error instanceof RepoContextCommitUnavailableError) {
    return {
      name: REPO_CONTEXT_COMMIT_UNAVAILABLE_ERROR_NAME,
      code: REPO_CONTEXT_COMMIT_UNAVAILABLE_ERROR_CODE,
    };
  }
  if (
    error instanceof McpConnectionAuthNotRemoteError ||
    error instanceof McpConnectionAuthRejectedError
  ) {
    return { name: MCP_CONNECTION_AUTH_INVALID_ERROR_NAME, code: error.code };
  }
  if (error instanceof ManagedConnectionNotReadyError) {
    return {
      name: MANAGED_CONNECTION_NOT_READY_ERROR_NAME,
      code: MANAGED_CONNECTION_NOT_READY_ERROR_CODE,
    };
  }
  if (error instanceof WorkerStoppedError) {
    return {
      name: WORKER_STOPPED_ERROR_NAME,
      code: WORKER_STOPPED_ERROR_CODE,
    };
  }
  if (error instanceof ManagedAuthorityLostError) {
    return {
      name: MANAGED_CONNECTION_AUTHORITY_LOST_ERROR_NAME,
      code: MANAGED_CONNECTION_AUTHORITY_LOST_ERROR_CODE,
    };
  }
  if (error instanceof McpToolStepError) {
    return { name: error.errorName, code: error.code };
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
      ...(error instanceof ManagedAuthorityLostError
        ? { cause: { reason: error.reason } }
        : {}),
      ...(error instanceof ManagedConnectionNotReadyError
        ? { cause: error.details }
        : {}),
    },
  };
}

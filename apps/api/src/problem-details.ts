import {
  ElysiaError,
  ElysiaStatus,
  InternalServerError,
  InvalidCookie,
  NotFound,
  ParseError,
  ValidationError,
} from "elysia";
import { ManagedLoopbackCompletionFailedError } from "@scarn/core/connections/managed-mcp-connection/application/complete-managed-loopback-attempt";
import {
  ManagedConnectionNotReadyError,
  ManagedConnectionRequiresCliError,
} from "@scarn/core/connections/managed-mcp-connection/application/managed-connection-access";
import { ManagedConnectionIssuerChangedError } from "@scarn/core/connections/managed-mcp-connection/application/managed-mcp-server-prober";
import { ManagedRelayError } from "@scarn/core/connections/managed-mcp-connection/application/relay-managed-mcp-call";
import { CoreError, CoreValidationError } from "@scarn/core/lib/errors";
import { ConcurrencyGroupFullError } from "@scarn/core/tasks/task/application/task-group";
import type { ApiErrorResponse } from "./contracts";

type ProblemDetailsOptions = {
  error: unknown;
  request: Request;
};

type ProblemClassification = Pick<
  ApiErrorResponse,
  "type" | "title" | "status"
>;

type Problem = ProblemClassification &
  Pick<ApiErrorResponse, "code" | "detail" | "errors">;

const PROBLEM_TYPE_BASE = "urn:problem-type:scarn:api";

const UNEXPECTED_ERROR_DETAIL = "An unexpected error occurred.";

const INTERNAL_SERVER_ERROR: ProblemClassification = {
  type: `${PROBLEM_TYPE_BASE}:internal-server-error`,
  title: "Internal Server Error",
  status: 500,
};

// eslint-disable-next-line local/no-unknown-parameter-type
function getErrorStatus(error: unknown): number | undefined {
  return typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
    ? error.status
    : undefined;
}

// eslint-disable-next-line local/no-unknown-parameter-type
function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

// eslint-disable-next-line local/no-unknown-parameter-type
function getErrorExpose(error: unknown): boolean | undefined {
  return typeof error === "object" &&
    error !== null &&
    "expose" in error &&
    typeof error.expose === "boolean"
    ? error.expose
    : undefined;
}

// eslint-disable-next-line local/no-unknown-parameter-type
function getErrorMessage(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : undefined;
}

// eslint-disable-next-line local/no-unknown-parameter-type
function getPublicErrorMessage(error: unknown): string | undefined {
  return getErrorExpose(error) === false ? undefined : getErrorMessage(error);
}

function getValidationErrors(
  error: ValidationError,
): ApiErrorResponse["errors"] {
  return error.all.map((issue: { path?: string; message: string }) => ({
    path: issue.path || "/",
    message: issue.message,
    summary: issue.message,
  }));
}

function describeValidationError(error: ValidationError): Problem {
  return {
    type: `${PROBLEM_TYPE_BASE}:validation`,
    title: "Unprocessable Content",
    status: 422,
    code: "VALIDATION",
    detail: "Request validation failed.",
    errors: getValidationErrors(error),
  };
}

function describeStatusResponse(status: number): Problem {
  return {
    type: `${PROBLEM_TYPE_BASE}:http-${String(status)}`,
    title: "Request Failed",
    status,
    code: String(status),
  };
}

/**
 * Maps Elysia's own errors onto the problem `type`/`code` vocabulary the
 * API published before Elysia 2, whose error classes carry lowercase slug
 * codes that must not leak into responses.
 */
function describeElysiaError(error: Error & { status?: number }): Problem {
  if (error instanceof NotFound) {
    return {
      type: `${PROBLEM_TYPE_BASE}:not-found`,
      title: "Not Found",
      status: 404,
      code: "NOT_FOUND",
      detail: error.message || "The requested resource was not found.",
    };
  }

  if (error instanceof ParseError) {
    return {
      type: `${PROBLEM_TYPE_BASE}:parse`,
      title: "Bad Request",
      status: 400,
      code: "PARSE",
      detail: "The request body could not be parsed.",
    };
  }

  if (error instanceof InvalidCookie && getErrorStatus(error) === 400) {
    return {
      type: `${PROBLEM_TYPE_BASE}:invalid-cookie-signature`,
      title: "Bad Request",
      status: 400,
      code: "INVALID_COOKIE_SIGNATURE",
      detail: error.message,
    };
  }

  if (error instanceof InternalServerError || (error.status ?? 500) >= 500) {
    return {
      ...INTERNAL_SERVER_ERROR,
      code: "INTERNAL_SERVER_ERROR",
      detail: UNEXPECTED_ERROR_DETAIL,
    };
  }

  const status = error.status ?? 500;
  return {
    type: `${PROBLEM_TYPE_BASE}:http-${String(status)}`,
    title: error.message || "Request Failed",
    status,
    code: String(status),
    detail: error.message || undefined,
  };
}

// eslint-disable-next-line local/no-unknown-parameter-type
function describeApplicationError(error: unknown): Problem {
  const errorStatus = getErrorStatus(error);
  const errorMessage = getPublicErrorMessage(error);
  const code = getErrorCode(error) ?? "UNKNOWN";
  const detail =
    errorStatus && errorMessage ? errorMessage : UNEXPECTED_ERROR_DETAIL;

  if (!errorStatus || (errorStatus >= 500 && !errorMessage)) {
    return { ...INTERNAL_SERVER_ERROR, code, detail };
  }

  return {
    type: `${PROBLEM_TYPE_BASE}:http-${String(errorStatus)}`,
    title: errorMessage || "Request Failed",
    status: errorStatus,
    code,
    detail,
  };
}

/**
 * Elysia wraps whatever a route's `parse` hook throws in a `ParseError`; a
 * `CoreError` the hook threw on purpose (a body over a route's cap) is the
 * error to report.
 */
// eslint-disable-next-line local/no-unknown-parameter-type
function unwrapParseHookError(error: unknown): unknown {
  return error instanceof ParseError && error.cause instanceof CoreError
    ? error.cause
    : error;
}

// eslint-disable-next-line local/no-unknown-parameter-type
function describeProblem(error: unknown): Problem {
  if (error instanceof ValidationError) return describeValidationError(error);
  if (error instanceof ElysiaStatus) {
    return describeStatusResponse(getErrorStatus(error) ?? 500);
  }
  if (error instanceof ElysiaError) return describeElysiaError(error);
  return describeApplicationError(error);
}

/** Only client-facing validation errors, concurrency group drops,
 * not-ready managed connections, CLI-only sign-ins, changed custom-server
 * issuers and failed loopback completions carry their
 * structured `meta` to the response; other errors' meta may hold internal
 * identifiers. */
// eslint-disable-next-line local/no-unknown-parameter-type
function getPublicErrorMeta(error: unknown): ApiErrorResponse["meta"] {
  return error instanceof CoreValidationError ||
    error instanceof ConcurrencyGroupFullError ||
    error instanceof ManagedConnectionNotReadyError ||
    error instanceof ManagedConnectionRequiresCliError ||
    error instanceof ManagedConnectionIssuerChangedError ||
    error instanceof ManagedRelayError ||
    error instanceof ManagedLoopbackCompletionFailedError
    ? error.meta
    : undefined;
}

/** A `CoreError` asking the client to back off sets `meta.retryAfterSeconds`. */
// eslint-disable-next-line local/no-unknown-parameter-type
export function getRetryAfterSeconds(error: unknown): number | undefined {
  if (!(error instanceof CoreError)) return undefined;
  const value = error.meta?.["retryAfterSeconds"];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.ceil(value)
    : undefined;
}

export function createProblemDetails({
  error: thrown,
  request,
}: ProblemDetailsOptions): ApiErrorResponse {
  const error = unwrapParseHookError(thrown);
  const { type, title, status, code, detail, errors } = describeProblem(error);

  return {
    type,
    title,
    status,
    detail,
    instance: new URL(request.url).pathname,
    code,
    errors,
    meta: getPublicErrorMeta(error),
  };
}

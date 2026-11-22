import { noopLogger, type Logger } from "@scarn/observability/logging";
import { createProblemDetails, getRetryAfterSeconds } from "../problem-details";

type ApiErrorHandlerContext = {
  error: unknown;
  request: Request;
  set: {
    status?: string | number;
    headers: Record<string, unknown>;
  };
};

export function apiErrorHandler(
  { error, request, set }: ApiErrorHandlerContext,
  logger: Logger = noopLogger,
) {
  const problem = createProblemDetails({ error, request });

  if (problem.status >= 500) {
    logger.error(
      {
        err: error,
        method: request.method,
        path: problem.instance,
        status: problem.status,
        code: problem.code,
      },
      "API request failed",
    );
  }

  set.status = problem.status;
  set.headers["content-type"] = "application/problem+json";
  const retryAfterSeconds = getRetryAfterSeconds(error);
  if (retryAfterSeconds !== undefined) {
    set.headers["retry-after"] = String(retryAfterSeconds);
  }

  return problem;
}

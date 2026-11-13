import { describeApiError } from "./api-errors";
import type { ApiResult } from "./api-result";

/**
 * Why a safe action (rerun, cancel, retry, message, comment, answer) did not
 * happen, by the API's HTTP status or by a check made before calling it. The
 * CLI maps each kind to a failure code; the message is the API's own
 * Problem Details sentence, prefixed with what was being attempted.
 */

export const ACTION_ERROR_KINDS = [
  "not_found",
  "forbidden",
  "conflict",
  "rejected",
  "failed",
] as const;

export type ActionErrorKind = (typeof ACTION_ERROR_KINDS)[number];

export class ActionError extends Error {
  public constructor(
    public readonly kind: ActionErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ActionError";
  }
}

/** 404 → `not_found`, 401/403 → `forbidden`, 409 → `conflict`, 400/422 →
 * `rejected`, anything else → `failed`. */
export function actionErrorKind(status: number): ActionErrorKind {
  if (status === 404) return "not_found";
  if (status === 401 || status === 403) return "forbidden";
  if (status === 409) return "conflict";
  if (status === 400 || status === 422) return "rejected";
  return "failed";
}

/** The response body, or an {@link ActionError} reading `Could not <what>: …`. */
export function unwrapAction<T>(what: string, result: ApiResult<T>): T {
  if (result.error !== undefined) {
    throw new ActionError(
      actionErrorKind(result.error.status),
      `Could not ${what}: ${describeApiError(result.error)}`,
    );
  }
  return result.data;
}

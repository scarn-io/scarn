/**
 * A Task's retry policy and the one decision it makes: whether a failed run
 * gets another run. The policy is a pipeline node's (or step definition's)
 * `retry` list, copied onto the Task as `retryJson`.
 */
import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import type { TaskRunStatus } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import { MANAGED_CONNECTION_NOT_READY_ERROR } from "@scarn/core/connections/managed-mcp-connection/domain/managed-connection-not-ready";
import { MANAGED_CONNECTION_AUTHORITY_LOST } from "@scarn/core/connections/managed-mcp-connection/domain/managed-seal-authority";

export const ALL_ERRORS = "Scarn.All";

/** One `retry` entry: retry errors named in `on` up to `maxAttempts` times. */
export type RetryPolicyEntry = { on: string[]; maxAttempts: number };

export type RetryDecision = { retry: true } | { retry: false };

/** The run statuses that count as a failed attempt: failed, timed out, or abandoned. */
export const FAILED_RUN_STATUSES: ReadonlySet<TaskRunStatus> = new Set([
  "failed",
  "timeout",
  "abandoned",
]);

/** Whether an error named `name` matches a `retry`/`catch` entry's `on` list. */
export function errorMatches(on: readonly string[], name: string): boolean {
  return on.includes(name) || on.includes(ALL_ERRORS);
}

const isRetryEntry = (value: AnyJsonValue): value is RetryPolicyEntry => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const { on, maxAttempts } = value;
  return (
    Array.isArray(on) &&
    on.every((name) => typeof name === "string") &&
    typeof maxAttempts === "number"
  );
};

/** The entries of a stored `retryJson`; anything that isn't an entry is ignored. */
export function retryPolicy(
  retryJson: AnyJsonValue | null,
): RetryPolicyEntry[] {
  return Array.isArray(retryJson) ? retryJson.filter(isRetryEntry) : [];
}

/**
 * What the retry decision knows of a failed run: its named error, and
 * whether a relayed managed call it started had no known outcome when the
 * run ended (an operation row was still present).
 */
export type RunFailure = { name: string; operationUnknown?: boolean };

const NEVER_RETRIED_ERRORS: ReadonlySet<string> = new Set([
  MANAGED_CONNECTION_AUTHORITY_LOST,
  MANAGED_CONNECTION_NOT_READY_ERROR,
]);

/**
 * Whether the server forbids retrying `failure` whatever the `retry` list
 * says (decisions 5, 13, 16): a lost managed connection authority, a managed
 * connection that wasn't ready, or a run that ended with a managed call's
 * outcome unknown. A retry would repeat provider effects or fail the same way.
 */
export function isNeverRetried(failure: RunFailure): boolean {
  return (
    failure.operationUnknown === true || NEVER_RETRIED_ERRORS.has(failure.name)
  );
}

/**
 * Whether a run that failed with `failure` is retried. A failure the server
 * never retries (`isNeverRetried`) isn't, before any entry is matched.
 * Otherwise the first entry whose `on` matches decides; it allows
 * `maxAttempts` retries, and `attempts` is how many of the Task's earlier
 * runs already failed (each was retried).
 */
export function retryDecision(
  retry: AnyJsonValue | null,
  failure: RunFailure,
  attempts: number,
): RetryDecision {
  if (isNeverRetried(failure)) {
    return { retry: false };
  }
  const entry = retryPolicy(retry).find((candidate) =>
    errorMatches(candidate.on, failure.name),
  );
  return entry !== undefined && attempts < entry.maxAttempts
    ? { retry: true }
    : { retry: false };
}

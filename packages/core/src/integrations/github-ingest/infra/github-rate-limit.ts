import { noopLogger, type Logger } from "@scarn/observability/logging";

/**
 * Absolute (not percentage-of-limit) `X-RateLimit-Remaining` floor below
 * which the reconcile sweep stops dispatching further integrations for the
 * current run (`github-integration-sync-scaling` plan, Phase 5, decision
 * 18). Kept as a single constant rather than a percentage of
 * `X-RateLimit-Limit` so it's simple to reason about and adjust.
 */
export const GITHUB_RATE_LIMIT_MIN_REMAINING = 100;

export type GitHubRateLimitStatus = {
  /** Parsed `X-RateLimit-Remaining`, or `null` if the header was absent/unparseable. */
  remaining: number | null;
  /** Parsed `Retry-After` (seconds), or `null` if the header was absent/unparseable. */
  retryAfterSeconds: number | null;
};

const parseNumericHeader = (value: string | null): number | null => {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const readGitHubRateLimitStatus = (
  response: Response,
): GitHubRateLimitStatus => ({
  remaining: parseNumericHeader(response.headers.get("x-ratelimit-remaining")),
  retryAfterSeconds: parseNumericHeader(response.headers.get("retry-after")),
});

/**
 * Whether a failed response is GitHub's primary or secondary rate limit
 * rather than lost access: a 403 or 429 that carries `Retry-After` or
 * `X-RateLimit-Remaining: 0`. A plain 403 (including an SSO one) is not.
 */
export const isGitHubRateLimitResponse = (
  response: Pick<Response, "status" | "headers">,
): boolean =>
  (response.status === 403 || response.status === 429) &&
  (response.headers.get("retry-after") !== null ||
    response.headers.get("x-ratelimit-remaining") === "0");

/**
 * A response signals GitHub wants the caller to back off when either its
 * remaining budget has dropped below `GITHUB_RATE_LIMIT_MIN_REMAINING`, or
 * GitHub sent an explicit `Retry-After` (the secondary/abuse-detection rate
 * limit, which doesn't always come with a meaningful `X-RateLimit-Remaining`).
 */
export const isGitHubRateLimitLow = (status: GitHubRateLimitStatus): boolean =>
  (status.remaining !== null &&
    status.remaining < GITHUB_RATE_LIMIT_MIN_REMAINING) ||
  status.retryAfterSeconds !== null;

/**
 * A mutable, run-scoped signal that low-level GitHub API clients
 * (`github-issues-client.ts`, `github-relationships-client.ts`) record
 * every response's rate-limit headers onto, and that
 * `reconcileActiveIntegrations`'s bounded-concurrency loop polls as its
 * stop condition. Deliberately a signal rather than a thrown error: a
 * response can be `ok` and still be the one that trips the threshold, and
 * tripping it must not mark the integration that happened to make that call
 * as failed/errored — it only means "don't start any more integrations this
 * run."
 */
export type GitHubRateLimitSignal = {
  readonly isExhausted: boolean;
  recordResponse(response: Response): void;
};

export const createGitHubRateLimitSignal = (
  logger: Logger = noopLogger,
): GitHubRateLimitSignal => {
  let exhausted = false;

  return {
    get isExhausted() {
      return exhausted;
    },
    recordResponse(response) {
      const status = readGitHubRateLimitStatus(response);
      if (!isGitHubRateLimitLow(status)) return;
      if (!exhausted) {
        logger.warn(
          {
            remaining: status.remaining,
            retryAfterSeconds: status.retryAfterSeconds,
          },
          "GitHub API rate limit budget low; halting further integration syncs for this reconcile run",
        );
      }
      exhausted = true;
    },
  };
};

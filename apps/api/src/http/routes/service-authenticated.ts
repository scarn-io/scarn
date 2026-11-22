import { timingSafeEqual } from "node:crypto";
import { Elysia } from "elysia";
import { ConfigurationError, CoreError } from "@scarn/core/lib/errors";

const DEFAULT_SERVICE_TOKEN_ENV = "RECONCILE_CRON_SECRET";
const BEARER_PREFIX = "Bearer ";

/**
 * Constant-time comparison of two strings. Matches the idiom used by
 * `install-state.ts` / `verify-webhook-signature.ts`: `timingSafeEqual` throws
 * on length mismatch, so guard length first (the early `false` is acceptable —
 * the timing channel it opens leaks only the secret's LENGTH, not its bytes).
 */
const tokensMatch = (provided: string, expected: string): boolean => {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
};

const extractBearerToken = (authorization: string | null): string => {
  if (!authorization || !authorization.startsWith(BEARER_PREFIX)) {
    return "";
  }
  return authorization.slice(BEARER_PREFIX.length);
};

/**
 * Guard for machine-to-machine maintenance routes (e.g. the storage
 * reconciliation trigger invoked by the EventBridge scheduler). It authenticates
 * a SERVICE caller via a shared bearer token rather than a user session, so
 * there is no `auth` actor on the request — these routes act on the system, not
 * on behalf of a user.
 *
 * The env var checked defaults to `RECONCILE_CRON_SECRET`, but callers may pass
 * a different env var name to guard a different route with its own dedicated
 * secret (e.g. `GITHUB_RECONCILE_CRON_SECRET` for the GitHub reconciliation
 * route) — isolating secrets per job allows independent rotation/audit and
 * keeps their security postures decoupled, at the cost of one more env var per
 * job.
 *
 * Fail-closed: a missing/empty secret raises a {@link ConfigurationError} (500)
 * rather than silently allowing the request, so a misconfigured deploy can
 * never leave the route open. The token is compared in constant time to avoid
 * leaking it through response timing.
 */
export const createServiceAuthenticated = (
  serviceTokenEnv: string = DEFAULT_SERVICE_TOKEN_ENV,
) =>
  new Elysia({ name: "service-authenticated" }).derive(
    "plugin",
    ({ request }) => {
      const expected = process.env[serviceTokenEnv];
      if (!expected) {
        throw new ConfigurationError(
          `${serviceTokenEnv} is not configured; service routes are disabled`,
          "MISSING_SERVICE_TOKEN",
        );
      }

      const provided = extractBearerToken(request.headers.get("authorization"));
      if (!tokensMatch(provided, expected)) {
        throw new CoreError({
          code: "UNAUTHORIZED",
          message: "Invalid or missing service token",
          status: 401,
        });
      }

      return { service: { authenticated: true as const } };
    },
  );

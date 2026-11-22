/**
 * Edge rate limits, checked before any Durable Object is touched. They protect
 * DOs and CPU, not the account's request count: a limited request is still a
 * billed Worker request. Limits and periods live in `deploy.json` (mirrored in
 * `wrangler.jsonc`); this module only decides the keys:
 * - `AUTH_FAIL_LIMITER`: failed bearer or token checks, per client IP. Valid
 *   requests are never counted, so the API's own calls are never limited.
 * - `WS_WORKER_LIMITER` / `WS_ORG_LIMITER`: work-signal connects per
 *   `${oid}:${sub}`, then per `oid`.
 * - `FEED_WRITER_LIMITER`: log-feed writer connects per task run.
 * - `FEED_READER_LIMITER`: log-feed reader connects per `${ip}:${tid}`.
 *
 * Requests without `cf-connecting-ip` (local dev, tests) share the
 * `UNKNOWN_IP` key.
 */
import {
  type EventContext,
  type RejectReason,
  recordRejection,
} from "./metering";

export const UNKNOWN_IP = "unknown";

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || UNKNOWN_IP;
}

export async function withinLimit(
  limiter: RateLimit,
  key: string,
): Promise<boolean> {
  const { success } = await limiter.limit({ key });
  return success;
}

export function tooManyRequests(): Response {
  return new Response("Too many requests", { status: 429 });
}

/**
 * Counts a failed auth check against the caller's IP: 401, or 429 once over.
 * Records a `rejected` event (`auth` or `rate_ip`) with whatever ids the
 * route already knows (unverified, from the path).
 */
export async function rejectAuth(
  request: Request,
  env: Cloudflare.Env,
  context: EventContext = {},
): Promise<Response> {
  if (!(await withinLimit(env.AUTH_FAIL_LIMITER, clientIp(request)))) {
    recordRejection(env, "rate_ip", context);
    return tooManyRequests();
  }
  recordRejection(env, "auth", context);
  return new Response("Unauthorized", { status: 401 });
}

/** Records a rate-limit rejection and answers 429. */
export function rejectRate(
  env: Cloudflare.Env,
  reason: RejectReason,
  context: EventContext,
): Response {
  recordRejection(env, reason, context);
  return tooManyRequests();
}

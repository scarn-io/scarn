/**
 * Internal routes the API uses to reach a run's `TaskRunLogFeed`, all behind
 * a bearer `LOG_FEED_INTERNAL_SECRET`. JSON shapes mirror core's
 * `LogFeedStore`:
 * - `POST …/append` `{ lines }` → `{ nextOffset }`; `409 { error: "sealed" }`,
 *   `413 { error: "too-many-lines" | "too-large" | "feed-full" }`,
 *   `429 { error: "rate-limited" }`, `400` on a malformed body.
 * - `GET …/read?from=N&limit=M` → `{ lines, nextOffset }`
 * - `GET …/read-all` → `{ lines }`
 * - `POST …/seal` → `204`
 */
import { bearerMatches, methodNotAllowed } from "./http";
import { rejectAuth } from "./limits";
import { parseAppendBody } from "./log-lines";
import type { AppendError } from "./task-run-log-feed";

export const INTERNAL_ROUTE =
  /^\/internal\/task-runs\/([^/]+)\/(append|read|read-all|seal)$/;

const APPEND_ERROR_STATUS: Record<AppendError, number> = {
  sealed: 409,
  "too-many-lines": 413,
  "too-large": 413,
  "rate-limited": 429,
  "feed-full": 413,
};

export async function handleInternalLogFeed(
  request: Request,
  env: Cloudflare.Env,
  url: URL,
  match: RegExpExecArray,
): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  const taskRunId = decodeURIComponent(match[1] ?? "");
  if (!bearerMatches(auth, env.LOG_FEED_INTERNAL_SECRET)) {
    return rejectAuth(request, env, { tid: taskRunId });
  }
  const feed = env.TASK_RUN_LOG_FEED.get(
    env.TASK_RUN_LOG_FEED.idFromName(taskRunId),
  );

  switch (match[2]) {
    case "append": {
      if (request.method !== "POST") return methodNotAllowed("POST");
      const lines = parseAppendBody(await request.text());
      if (!lines) return new Response("Invalid lines", { status: 400 });
      const result = await feed.append(lines);
      if ("error" in result) {
        return Response.json(result, {
          status: APPEND_ERROR_STATUS[result.error],
        });
      }
      return Response.json(result);
    }
    case "read": {
      if (request.method !== "GET") return methodNotAllowed("GET");
      const from = Number(url.searchParams.get("from") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "1000");
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(limit)) {
        return new Response("Invalid from or limit", { status: 400 });
      }
      return Response.json(await feed.read(from, limit));
    }
    case "read-all":
      if (request.method !== "GET") return methodNotAllowed("GET");
      return Response.json({ lines: await feed.readAll() });
    default:
      if (request.method !== "POST") return methodNotAllowed("POST");
      await feed.seal();
      return new Response(null, { status: 204 });
  }
}

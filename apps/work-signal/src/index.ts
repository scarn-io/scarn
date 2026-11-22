/**
 * Work-signal Worker: wakes idle `scarn work` workers when the API reports
 * that work may be available. Edge rate limits run before any Durable Object
 * is touched; see `limits.ts`. Connects, notifies and rejections are metered;
 * see `metering.ts`. Routes:
 * - `GET /health`
 * - `POST /projects/:projectId/notify` (bearer `WORK_SIGNAL_NOTIFY_SECRET`)
 * - `GET /projects/:projectId/connect?token=…` (WebSocket upgrade)
 * - `POST /internal/task-runs/:taskRunId/{append,read,read-all,seal}`
 *   (bearer `LOG_FEED_INTERNAL_SECRET`; see `internal-log-feed.ts`)
 * - `GET /task-runs/:taskRunId/ws?token=…&from=N` (WebSocket upgrade; the
 *   log-feed token's scope makes the socket a writer or a reader; see
 *   `task-run-log-feed.ts`)
 */
import { handleInternalLogFeed, INTERNAL_ROUTE } from "./internal-log-feed";
import { bearerMatches, methodNotAllowed } from "./http";
import { clientIp, rejectAuth, rejectRate, withinLimit } from "./limits";
import { type LogFeedClaims, verifyLogFeedToken } from "./log-feed-token";
import { record } from "./metering";
import { TOKEN_EXP_HEADER, WORKER_ID_HEADER } from "./project-work-signal";
import {
  FROM_HEADER,
  ROLE_HEADER,
  TOKEN_EXP_HEADER as LOG_FEED_TOKEN_EXP_HEADER,
} from "./task-run-log-feed";
import { verifyWorkSignalToken } from "./token";

export { ProjectWorkSignal } from "./project-work-signal";
export { TaskRunLogFeed } from "./task-run-log-feed";

const PROJECT_ROUTE = /^\/projects\/([^/]+)\/(notify|connect)$/;
const LOG_FEED_WS_ROUTE = /^\/task-runs\/([^/]+)\/ws$/;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return new Response("ok");
    }

    const internal = INTERNAL_ROUTE.exec(url.pathname);
    if (internal) return handleInternalLogFeed(request, env, url, internal);

    const logFeed = LOG_FEED_WS_ROUTE.exec(url.pathname);
    if (logFeed) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return connectLogFeed(
        request,
        env,
        url,
        decodeURIComponent(logFeed[1] ?? ""),
      );
    }

    const match = PROJECT_ROUTE.exec(url.pathname);
    if (!match) return new Response("Not found", { status: 404 });
    const projectId = decodeURIComponent(match[1] ?? "");
    const action = match[2];

    if (action === "notify") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return notify(request, env, projectId);
    }
    if (request.method !== "GET") return methodNotAllowed("GET");
    return connect(request, env, url, projectId);
  },
} satisfies ExportedHandler<Cloudflare.Env>;

async function notify(
  request: Request,
  env: Cloudflare.Env,
  projectId: string,
): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  if (!bearerMatches(auth, env.WORK_SIGNAL_NOTIFY_SECRET)) {
    return rejectAuth(request, env, { pid: projectId });
  }
  const notified = await projectStub(env, projectId).notify();
  record(env, { event: "notify", pid: projectId, notified });
  return Response.json({ notified });
}

async function connect(
  request: Request,
  env: Cloudflare.Env,
  url: URL,
  projectId: string,
): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }
  const token = url.searchParams.get("token") ?? "";
  const claims = await verifyWorkSignalToken(
    token,
    env.WORK_SIGNAL_TOKEN_SECRET,
  );
  if (claims?.pid !== projectId) {
    return rejectAuth(request, env, { pid: projectId });
  }
  const context = { pid: projectId, oid: claims.oid, sub: claims.sub };
  if (
    !(await withinLimit(env.WS_WORKER_LIMITER, `${claims.oid}:${claims.sub}`))
  ) {
    return rejectRate(env, "rate_worker", context);
  }
  if (!(await withinLimit(env.WS_ORG_LIMITER, claims.oid))) {
    return rejectRate(env, "rate_org", context);
  }
  record(env, { event: "signal_connect", ...context });
  const headers = new Headers(request.headers);
  headers.set(WORKER_ID_HEADER, claims.sub);
  headers.set(TOKEN_EXP_HEADER, String(claims.exp));
  return projectStub(env, projectId).fetch(
    new Request(request.url, { headers }),
  );
}

async function connectLogFeed(
  request: Request,
  env: Cloudflare.Env,
  url: URL,
  taskRunId: string,
): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }
  const from = Number(url.searchParams.get("from") ?? "0");
  if (!Number.isSafeInteger(from) || from < 0) {
    return new Response("Invalid from", { status: 400 });
  }
  const token = url.searchParams.get("token") ?? "";
  const claims = await verifyEitherScope(token, env, taskRunId);
  if (!claims) return rejectAuth(request, env, { tid: taskRunId });
  const context = { pid: claims.pid, oid: claims.oid, tid: taskRunId };
  if (claims.scope === "write") {
    if (!(await withinLimit(env.FEED_WRITER_LIMITER, taskRunId))) {
      return rejectRate(env, "rate_writer", context);
    }
    record(env, { event: "feed_writer_connect", ...context });
  } else {
    const key = `${clientIp(request)}:${taskRunId}`;
    if (!(await withinLimit(env.FEED_READER_LIMITER, key))) {
      return rejectRate(env, "rate_reader", context);
    }
    record(env, { event: "feed_reader_connect", ...context });
  }

  const headers = new Headers(request.headers);
  headers.set(ROLE_HEADER, claims.scope === "write" ? "writer" : "reader");
  headers.set(FROM_HEADER, String(from));
  headers.set(LOG_FEED_TOKEN_EXP_HEADER, String(claims.exp));
  const feed = env.TASK_RUN_LOG_FEED.get(
    env.TASK_RUN_LOG_FEED.idFromName(taskRunId),
  );
  return feed.fetch(new Request(request.url, { headers }));
}

async function verifyEitherScope(
  token: string,
  env: Cloudflare.Env,
  taskRunId: string,
): Promise<LogFeedClaims | null> {
  const secret = env.LOG_FEED_TOKEN_SECRET;
  return (
    (await verifyLogFeedToken(token, secret, { taskRunId, scope: "write" })) ??
    (await verifyLogFeedToken(token, secret, { taskRunId, scope: "read" }))
  );
}

function projectStub(env: Cloudflare.Env, projectId: string) {
  return env.PROJECT_WORK_SIGNAL.get(
    env.PROJECT_WORK_SIGNAL.idFromName(projectId),
  );
}

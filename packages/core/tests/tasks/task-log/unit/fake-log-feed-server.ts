import { noopLogger } from "@scarn/observability/logging";
import { DurableObjectLogFeedStore } from "@/tasks/task-log/infra/durable-object-log-feed-store";
import type { LogLineContract } from "@/tasks/task-log/contracts/task-log-contracts";

export const FAKE_LOG_FEED_SECRET = "log-feed-internal-secret";

const MAX_BATCH_LINES = 1_000;
const MAX_BATCH_BYTES = 512 * 1024;
const MAX_READ_LINES = 2_000;
const ROUTE = /^\/internal\/task-runs\/([^/]+)\/(append|read|read-all|seal)$/;

type Feed = { lines: LogLineContract[]; maxSeq: number; sealed: boolean };

export type ReceivedLogFeedRequest = {
  method: string;
  path: string;
  authorization: string | null;
  lineCount: number;
};

/**
 * In-memory stand-in for `apps/work-signal`'s internal log-feed routes with the
 * `TaskRunLogFeed` semantics: appends drop `seq <= maxSeq`, batches over the
 * line or byte caps get 413, and a sealed feed rejects appends with 409 but
 * stays readable.
 */
export const startFakeLogFeedServer = () => {
  const feeds = new Map<string, Feed>();
  const received: ReceivedLogFeedRequest[] = [];
  let override: ((request: Request) => Response | Promise<Response>) | null =
    null;

  const feedFor = (taskRunId: string): Feed => {
    const existing = feeds.get(taskRunId);
    if (existing) return existing;
    const created: Feed = { lines: [], maxSeq: -1, sealed: false };
    feeds.set(taskRunId, created);
    return created;
  };

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.text() : "";
    const lines = body
      ? ((JSON.parse(body) as { lines?: LogLineContract[] }).lines ?? [])
      : [];
    received.push({
      method: request.method,
      path: url.pathname,
      authorization: request.headers.get("authorization"),
      lineCount: lines.length,
    });
    if (override) return override(request);
    if (
      request.headers.get("authorization") !== `Bearer ${FAKE_LOG_FEED_SECRET}`
    ) {
      return new Response("Unauthorized", { status: 401 });
    }
    const match = ROUTE.exec(url.pathname);
    if (!match) return new Response("Not found", { status: 404 });
    const feed = feedFor(decodeURIComponent(match[1] ?? ""));

    switch (match[2]) {
      case "append": {
        if (feed.sealed)
          return Response.json({ error: "sealed" }, { status: 409 });
        if (lines.length > MAX_BATCH_LINES) {
          return Response.json({ error: "too-many-lines" }, { status: 413 });
        }
        const fresh = lines
          .filter((line) => line.seq > feed.maxSeq)
          .sort((left, right) => left.seq - right.seq)
          .filter((line, i, all) => i === 0 || line.seq !== all[i - 1]?.seq);
        if (
          fresh.length > 0 &&
          new TextEncoder().encode(JSON.stringify(fresh)).byteLength >
            MAX_BATCH_BYTES
        ) {
          return Response.json({ error: "too-large" }, { status: 413 });
        }
        feed.lines.push(...fresh);
        feed.maxSeq = fresh.at(-1)?.seq ?? feed.maxSeq;
        return Response.json({ nextOffset: Math.max(feed.maxSeq, 0) });
      }
      case "read": {
        const from = Number(url.searchParams.get("from") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "1000");
        const cap = Math.min(Math.max(Math.floor(limit), 1), MAX_READ_LINES);
        const page = feed.lines.filter((line) => line.seq > from).slice(0, cap);
        return Response.json({
          lines: page,
          nextOffset: page.at(-1)?.seq ?? from,
        });
      }
      case "read-all":
        return Response.json({ lines: feed.lines });
      default:
        feed.sealed = true;
        return new Response(null, { status: 204 });
    }
  };

  const server = Bun.serve({ port: 0, fetch: handle });

  return {
    url: server.url.origin,
    received,
    /** Replaces every response until reset with `null`. */
    respondWith: (
      handler: ((request: Request) => Response | Promise<Response>) | null,
    ) => {
      override = handler;
    },
    isSealed: (taskRunId: string) => feeds.get(taskRunId)?.sealed ?? false,
    createStore: (options?: { timeoutMs?: number; internalSecret?: string }) =>
      new DurableObjectLogFeedStore({
        url: server.url.origin,
        internalSecret: options?.internalSecret ?? FAKE_LOG_FEED_SECRET,
        logger: noopLogger,
        ...(options?.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.timeoutMs }),
      }),
    stop: () => server.stop(true),
  };
};

export type FakeLogFeedServer = ReturnType<typeof startFakeLogFeedServer>;

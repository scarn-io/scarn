/**
 * Write side of a task run's live log feed (the `TaskRunLogFeed` Durable
 * Object in `apps/work-signal`).
 *
 * Holds one WebSocket per claimed task, authenticated with a short-lived write
 * token. {@link LogFeedSocket.append} sends `{"t":"append","id","lines"}` and
 * resolves on the matching `{"t":"ack"}`; a nack, an ack timeout or the socket
 * closing rejects it, and the caller ships that batch over HTTP instead. A
 * `feed-full` or `rate-limited` nack rejects with `LogFeedFullError` or
 * `LogFeedRateLimitedError`, which the caller does not retry over HTTP. The
 * DO drops lines at or below its highest stored `seq`, so a batch that lands
 * twice is harmless.
 *
 * The token is refreshed shortly before it expires (and after a 4001 close),
 * by connecting a new socket; the DO then closes the old one with 4002. Lost
 * sockets reconnect with jittered backoff. The socket gives up for good when
 * the feed is sealed (the run is archived) or the token route answers that
 * the feed is unavailable, leaving every send to HTTP.
 */
import { logFeedLimitErrorFromNack } from "../contracts/log-feed-errors";
import type { LogFeedToken } from "../contracts/socket-token-types";
import type {
  ProjectWorkLogger,
  TaskLogLine,
} from "../contracts/process-project-work-types";
import { KEEPALIVE_PING, type WorkSignalSocket } from "./work-signal-client";

/** Must match `apps/work-signal/src/task-run-log-feed.ts`. */
export const LOG_FEED_CLOSE_SEALED = 1000;
export const LOG_FEED_CLOSE_TOKEN_EXPIRED = 4001;
export const LOG_FEED_CLOSE_WRITER_REPLACED = 4002;

export type LogFeedSocketOptions = {
  taskRunId: string;
  token: LogFeedToken;
  /** Resolves `null` when the feed is no longer available to this claim. */
  refreshToken(): Promise<LogFeedToken | null>;
  createSocket?: ((url: string) => WorkSignalSocket) | undefined;
  random?: (() => number) | undefined;
  now?: (() => number) | undefined;
  logger?: ProjectWorkLogger | undefined;
  minBackoffMs?: number | undefined;
  maxBackoffMs?: number | undefined;
  pingIntervalMs?: number | undefined;
  refreshLeadMs?: number | undefined;
  minRefreshDelayMs?: number | undefined;
  ackTimeoutMs?: number | undefined;
};

export type LogFeedSocket = {
  /** Opens the first socket. */
  start(): void;
  /** Whether an append can be sent right now. */
  isConnected(): boolean;
  /** Rejects when not connected, or on nack, ack timeout or close. */
  append(lines: TaskLogLine[]): Promise<{ nextOffset: number }>;
  /** Clears every timer, rejects pending appends and closes the socket. Idempotent. */
  stop(): void;
};

type PendingAppend = {
  socket: WorkSignalSocket;
  timer: ReturnType<typeof setTimeout>;
  resolve(result: { nextOffset: number }): void;
  reject(error: Error): void;
};

type ServerMessage =
  | { t: "ack"; id: number; nextOffset: number }
  | { t: "nack"; id: number | null; code: string }
  | { t: "sealed" };

const OPEN = 1;

export class LogFeedSocketError extends Error {
  override readonly name = "LogFeedSocketError";
}

function toConnectUrl(token: LogFeedToken) {
  const url = new URL(token.url);
  url.searchParams.set("token", token.token);
  return url.toString();
}

function parseServerMessage(data: string): ServerMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const message = parsed as Record<string, unknown>;
  if (
    message["t"] === "ack" &&
    typeof message["id"] === "number" &&
    typeof message["nextOffset"] === "number"
  ) {
    return { t: "ack", id: message["id"], nextOffset: message["nextOffset"] };
  }
  if (message["t"] === "nack") {
    return {
      t: "nack",
      id: typeof message["id"] === "number" ? message["id"] : null,
      code: typeof message["code"] === "string" ? message["code"] : "unknown",
    };
  }
  if (message["t"] === "sealed") {
    return { t: "sealed" };
  }
  return null;
}

function unrefTimer<T extends ReturnType<typeof setTimeout>>(handle: T): T {
  handle.unref();
  return handle;
}

export function createLogFeedSocket(
  options: LogFeedSocketOptions,
): LogFeedSocket {
  const createSocket =
    options.createSocket ?? ((url: string) => new WebSocket(url));
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const minBackoffMs = options.minBackoffMs ?? 1_000;
  const maxBackoffMs = options.maxBackoffMs ?? 60_000;
  const pingIntervalMs = options.pingIntervalMs ?? 30_000;
  const refreshLeadMs = options.refreshLeadMs ?? 2 * 60_000;
  const minRefreshDelayMs = options.minRefreshDelayMs ?? 10_000;
  const ackTimeoutMs = options.ackTimeoutMs ?? 10_000;

  let token = options.token;
  let stopped = false;
  let socket: WorkSignalSocket | null = null;
  let opened = false;
  let attempt = 0;
  let refreshing = false;
  let nextId = 1;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  const pending = new Map<number, PendingAppend>();
  const retired = new Set<WorkSignalSocket>();

  function log(message: string, details?: Record<string, unknown>) {
    options.logger?.log("log-feed", message, {
      taskRunId: options.taskRunId,
      ...details,
    });
  }

  function clearConnectionTimers() {
    clearTimeout(refreshTimer ?? undefined);
    clearInterval(pingTimer ?? undefined);
    refreshTimer = null;
    pingTimer = null;
  }

  function close(target: WorkSignalSocket) {
    target.onopen = null;
    target.onmessage = null;
    target.onclose = null;
    target.onerror = null;
    try {
      target.close(1000, "client closing");
    } catch {
      // Already closed.
    }
  }

  function closeRetiredIfIdle(target: WorkSignalSocket) {
    const busy = [...pending.values()].some((entry) => entry.socket === target);
    if (retired.has(target) && !busy) {
      retired.delete(target);
      close(target);
    }
  }

  function settle(id: number) {
    const entry = pending.get(id);
    if (!entry) {
      return null;
    }
    pending.delete(id);
    clearTimeout(entry.timer);
    closeRetiredIfIdle(entry.socket);
    return entry;
  }

  function rejectPending(target: WorkSignalSocket | null, reason: string) {
    for (const [id, entry] of [...pending]) {
      if (target === null || entry.socket === target) {
        settle(id)?.reject(new LogFeedSocketError(reason));
      }
    }
  }

  /** Detach `target` as the current socket, letting in-flight appends finish on it. */
  function retire(target: WorkSignalSocket | null) {
    if (target === null) {
      return;
    }
    if (target === socket) {
      socket = null;
      opened = false;
      clearConnectionTimers();
    }
    retired.add(target);
    closeRetiredIfIdle(target);
  }

  function disable(reason: string) {
    if (stopped) {
      return;
    }
    log("Log feed socket disabled; sending logs over HTTP", { reason });
    stop();
  }

  function backoffDelayMs() {
    const ceiling = Math.min(maxBackoffMs, minBackoffMs * 2 ** attempt);
    attempt += 1;
    return Math.round(ceiling / 2 + (random() * ceiling) / 2);
  }

  function scheduleReconnect(forceRefresh: boolean) {
    if (stopped || reconnectTimer !== null) {
      return;
    }
    const delayMs = backoffDelayMs();
    reconnectTimer = unrefTimer(
      setTimeout(() => {
        reconnectTimer = null;
        void connect(forceRefresh);
      }, delayMs),
    );
  }

  function scheduleRefresh() {
    const expiresAtMs = Date.parse(token.expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      return;
    }
    const delayMs = Math.max(
      minRefreshDelayMs,
      expiresAtMs - now() - refreshLeadMs,
    );
    refreshTimer = unrefTimer(
      setTimeout(() => {
        refreshTimer = null;
        void connect(true);
      }, delayMs),
    );
  }

  function handleMessage(target: WorkSignalSocket, event: MessageEvent) {
    const data: unknown = event.data;
    const message = typeof data === "string" ? parseServerMessage(data) : null;
    if (message === null) {
      return;
    }
    if (message.t === "ack") {
      settle(message.id)?.resolve({ nextOffset: message.nextOffset });
      return;
    }
    if (message.t === "nack") {
      if (message.id !== null) {
        settle(message.id)?.reject(
          logFeedLimitErrorFromNack(message.code) ??
            new LogFeedSocketError(`Log feed rejected batch: ${message.code}`),
        );
      }
      if (message.code === "sealed") {
        disable("sealed");
      }
      return;
    }
    if (target === socket) {
      disable("sealed");
    }
  }

  function handleClose(target: WorkSignalSocket, code: number | null) {
    rejectPending(target, `Log feed socket closed (${String(code)})`);
    if (retired.delete(target)) {
      close(target);
      return;
    }
    if (stopped || target !== socket) {
      return;
    }
    close(target);
    socket = null;
    opened = false;
    clearConnectionTimers();
    if (code === LOG_FEED_CLOSE_SEALED) {
      disable("sealed");
      return;
    }
    if (code === LOG_FEED_CLOSE_TOKEN_EXPIRED) {
      void connect(true);
      return;
    }
    log("Log feed socket lost", { code });
    scheduleReconnect(false);
  }

  function open() {
    const next = createSocket(toConnectUrl(token));
    socket = next;
    opened = false;

    next.onopen = () => {
      if (stopped || next !== socket) {
        return;
      }
      opened = true;
      attempt = 0;
      clearConnectionTimers();
      pingTimer = setInterval(() => {
        if (next.readyState === OPEN) {
          next.send(KEEPALIVE_PING);
        }
      }, pingIntervalMs);
      pingTimer.unref();
      scheduleRefresh();
    };
    next.onmessage = (event) => {
      handleMessage(next, event);
    };
    next.onclose = (event) => {
      handleClose(next, event.code);
    };
    next.onerror = () => {
      handleClose(next, null);
    };
  }

  function tokenIsFresh() {
    const expiresAtMs = Date.parse(token.expiresAt);
    return Number.isFinite(expiresAtMs) && expiresAtMs - now() > refreshLeadMs;
  }

  /** Read through a call: `stop()` may flip `stopped` while a refresh is awaited. */
  function isStopped() {
    return stopped;
  }

  async function connect(forceRefresh: boolean) {
    if (stopped || refreshing) {
      return;
    }
    if (forceRefresh || !tokenIsFresh()) {
      let refreshed: LogFeedToken | null;
      refreshing = true;
      try {
        refreshed = await options.refreshToken();
      } catch (error) {
        refreshing = false;
        if (isStopped()) {
          return;
        }
        log("Log feed token refresh failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        scheduleReconnect(true);
        return;
      }
      refreshing = false;
      if (isStopped()) {
        return;
      }
      if (refreshed === null) {
        disable("log feed unavailable for this claim");
        return;
      }
      token = refreshed;
    }
    retire(socket);
    try {
      open();
    } catch (error) {
      log("Log feed connect failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      socket = null;
      scheduleReconnect(false);
    }
  }

  function isConnected() {
    return !stopped && opened && socket !== null && socket.readyState === OPEN;
  }

  function append(lines: TaskLogLine[]) {
    const target = socket;
    if (!isConnected() || target === null) {
      return Promise.reject(
        new LogFeedSocketError("Log feed socket not connected"),
      );
    }
    const id = nextId++;
    return new Promise<{ nextOffset: number }>((resolve, reject) => {
      pending.set(id, {
        socket: target,
        resolve,
        reject,
        timer: unrefTimer(
          setTimeout(() => {
            settle(id)?.reject(
              new LogFeedSocketError("Log feed ack timed out"),
            );
          }, ackTimeoutMs),
        ),
      });
      try {
        target.send(JSON.stringify({ t: "append", id, lines }));
      } catch (error) {
        settle(id)?.reject(
          new LogFeedSocketError(
            `Log feed send failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  }

  function start() {
    if (stopped || socket !== null) {
      return;
    }
    void connect(false);
  }

  function stop() {
    if (stopped) {
      return;
    }
    stopped = true;
    clearTimeout(reconnectTimer ?? undefined);
    reconnectTimer = null;
    clearConnectionTimers();
    rejectPending(null, "Log feed socket stopped");
    for (const target of retired) {
      close(target);
    }
    retired.clear();
    if (socket !== null) {
      close(socket);
      socket = null;
    }
    opened = false;
  }

  return { start, isConnected, append, stop };
}

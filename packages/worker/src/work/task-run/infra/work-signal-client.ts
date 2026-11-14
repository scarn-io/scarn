/**
 * Push wake-up for an idle `scarn work` loop.
 *
 * Holds one WebSocket to the work-signal Worker (`apps/work-signal`) per
 * project. A `{"t":"work"}` message — and every (re)connect, so anything
 * queued while disconnected is claimed — resolves the next {@link wake} call
 * after 0–500 ms of jitter, which the poll loop races against its idle sleep.
 *
 * The socket is a hint, never a requirement: a token route answering 404
 * means push is off for this run, and any other failure is retried with
 * jittered backoff while the worker keeps polling.
 */
import type {
  ProjectWorkLogger,
  WorkReporter,
  WorkSignalToken,
} from "../contracts/process-project-work-types";

/** Must match `apps/work-signal/src/keepalive.ts` (checked by its keepalive test). */
export const KEEPALIVE_PING = "ping";
export const KEEPALIVE_PONG = "pong";

export type WorkSignalSocket = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
};

export type WorkSignalClientOptions = {
  projectId: string;
  fetchToken(): Promise<WorkSignalToken | null>;
  createSocket?: ((url: string) => WorkSignalSocket) | undefined;
  random?: (() => number) | undefined;
  now?: (() => number) | undefined;
  reporter?: WorkReporter | undefined;
  logger?: ProjectWorkLogger | undefined;
  minBackoffMs?: number | undefined;
  maxBackoffMs?: number | undefined;
  pingIntervalMs?: number | undefined;
  maxWakeJitterMs?: number | undefined;
  refreshLeadMs?: number | undefined;
  minRefreshDelayMs?: number | undefined;
};

export type WorkSignalClient = {
  /**
   * Fetches the first token and connects. Resolves `false` (and stays
   * inert) when the server has push disabled.
   */
  start(): Promise<boolean>;
  /** Resolves on the next wake, or at once if one is already pending. */
  wake(signal: AbortSignal): Promise<void>;
  /** Whether the socket is currently open. */
  isConnected(): boolean;
  /**
   * Resolves on the next disconnect, or at once if not connected. Aborting
   * `signal` drops the waiter.
   */
  disconnected(signal: AbortSignal): Promise<void>;
  /** Clears every timer and closes the socket. Idempotent. */
  stop(): void;
};

const OPEN = 1;
const WORK_MESSAGE = "work";

function toConnectUrl(signal: WorkSignalToken, projectId: string) {
  const base = signal.url.replace(/^http/, "ws").replace(/\/+$/, "");
  return `${base}/projects/${encodeURIComponent(projectId)}/connect?token=${encodeURIComponent(signal.token)}`;
}

function isWorkMessage(data: string) {
  if (data === KEEPALIVE_PONG) {
    return false;
  }
  try {
    const parsed = JSON.parse(data) as { t?: unknown };
    return parsed.t === WORK_MESSAGE;
  } catch {
    return false;
  }
}

export function createWorkSignalClient(
  options: WorkSignalClientOptions,
): WorkSignalClient {
  const createSocket =
    options.createSocket ?? ((url: string) => new WebSocket(url));
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const minBackoffMs = options.minBackoffMs ?? 1_000;
  const maxBackoffMs = options.maxBackoffMs ?? 60_000;
  const pingIntervalMs = options.pingIntervalMs ?? 30_000;
  const maxWakeJitterMs = options.maxWakeJitterMs ?? 500;
  const refreshLeadMs = options.refreshLeadMs ?? 2 * 60_000;
  const minRefreshDelayMs = options.minRefreshDelayMs ?? 30_000;

  let stopped = false;
  let connected = false;
  let attempt = 0;
  let socket: WorkSignalSocket | null = null;
  let pendingWake = false;
  let waiter: (() => void) | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  const wakeTimers = new Set<ReturnType<typeof setTimeout>>();
  const disconnectWaiters = new Set<() => void>();

  function log(message: string, details?: Record<string, unknown>) {
    options.logger?.log("work-signal", message, {
      projectId: options.projectId,
      ...details,
    });
  }

  function deliverWake() {
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve();
      return;
    }
    pendingWake = true;
  }

  function scheduleWake() {
    const timer = setTimeout(
      () => {
        wakeTimers.delete(timer);
        deliverWake();
      },
      Math.floor(random() * maxWakeJitterMs),
    );
    wakeTimers.add(timer);
  }

  function clearTimer(timer: ReturnType<typeof setTimeout> | null) {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }

  function clearConnectionTimers() {
    clearTimer(refreshTimer);
    refreshTimer = null;
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  function detach(target: WorkSignalSocket | null) {
    if (!target) {
      return;
    }
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

  function markDisconnected() {
    if (connected) {
      connected = false;
      options.reporter?.event({ type: "worker:signal-disconnected" });
      const waiters = [...disconnectWaiters];
      disconnectWaiters.clear();
      for (const resolve of waiters) {
        resolve();
      }
    }
  }

  function backoffDelayMs() {
    const ceiling = Math.min(maxBackoffMs, minBackoffMs * 2 ** attempt);
    attempt += 1;
    return Math.round(ceiling / 2 + (random() * ceiling) / 2);
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer !== null) {
      return;
    }
    const delayMs = backoffDelayMs();
    log("Work signal reconnect scheduled", { delayMs });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delayMs);
  }

  function handleLost(target: WorkSignalSocket, reason: string) {
    if (stopped || target !== socket) {
      return;
    }
    detach(target);
    socket = null;
    clearConnectionTimers();
    markDisconnected();
    log("Work signal socket lost", { reason });
    scheduleReconnect();
  }

  function scheduleRefresh(signal: WorkSignalToken) {
    const expiresAtMs = Date.parse(signal.expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      return;
    }
    const delayMs = Math.max(
      minRefreshDelayMs,
      expiresAtMs - now() - refreshLeadMs,
    );
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      log("Refreshing work signal token");
      detach(socket);
      socket = null;
      clearConnectionTimers();
      void connect();
    }, delayMs);
  }

  function open(signal: WorkSignalToken) {
    const next = createSocket(toConnectUrl(signal, options.projectId));
    socket = next;

    next.onopen = () => {
      if (stopped || next !== socket) {
        return;
      }
      attempt = 0;
      clearConnectionTimers();
      pingTimer = setInterval(() => {
        if (next.readyState === OPEN) {
          next.send(KEEPALIVE_PING);
        }
      }, pingIntervalMs);
      scheduleRefresh(signal);
      if (!connected) {
        connected = true;
        options.reporter?.event({ type: "worker:signal-connected" });
      }
      log("Work signal connected");
      scheduleWake();
    };
    next.onmessage = (event) => {
      const data: unknown = event.data;
      if (next === socket && typeof data === "string" && isWorkMessage(data)) {
        scheduleWake();
      }
    };
    next.onclose = (event) => {
      handleLost(next, `closed (${String(event.code)})`);
    };
    next.onerror = () => {
      handleLost(next, "error");
    };
  }

  async function fetchToken() {
    try {
      return { signal: await options.fetchToken() };
    } catch (error) {
      log("Work signal token request failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { failed: true as const };
    }
  }

  /** Read through a call: `stop()` may flip `stopped` while a fetch is awaited. */
  function isStopped() {
    return stopped;
  }

  function disable() {
    log("Work signal unavailable; polling only");
    stop();
  }

  async function connect(): Promise<boolean> {
    if (stopped) {
      return false;
    }
    const result = await fetchToken();
    if (isStopped()) {
      return false;
    }
    if ("failed" in result) {
      markDisconnected();
      scheduleReconnect();
      return true;
    }
    if (result.signal === null) {
      disable();
      return false;
    }
    try {
      open(result.signal);
    } catch (error) {
      log("Work signal connect failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      socket = null;
      markDisconnected();
      scheduleReconnect();
    }
    return true;
  }

  function wake(signal: AbortSignal) {
    if (pendingWake) {
      pendingWake = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const onWake = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        if (waiter === onWake) {
          waiter = null;
        }
      };
      waiter = onWake;
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  function isConnected() {
    return connected;
  }

  function disconnected(signal: AbortSignal) {
    if (!connected) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const onDisconnect = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        disconnectWaiters.delete(onDisconnect);
      };
      disconnectWaiters.add(onDisconnect);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  function stop() {
    if (stopped) {
      return;
    }
    stopped = true;
    clearTimer(reconnectTimer);
    reconnectTimer = null;
    clearConnectionTimers();
    for (const timer of wakeTimers) {
      clearTimeout(timer);
    }
    wakeTimers.clear();
    detach(socket);
    socket = null;
    markDisconnected();
  }

  return { start: connect, wake, isConnected, disconnected, stop };
}

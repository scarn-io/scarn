/**
 * One task run's log feed as seen by the browser. A live run asks for a read
 * token and receives new lines over the feed socket, reconnecting with backoff
 * from its cursor; when the feed isn't available (any token error, 404 when it
 * isn't configured, or {@link MAX_FAILED_CONNECTS} connects in a row that
 * close before opening or with 1008) it falls back to adaptive offset polling of
 * `GET /task-runs/:id/logs`. Once the feed is sealed (socket) or reports
 * `complete` (polling) the durable archive replaces the streamed lines.
 * Finished runs skip the token and go straight to the poll-then-archive path.
 */
import type { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { unwrapTreatyResponse } from "@/app/_lib/scarn-treaty";
import {
  isPageHidden,
  waitUntilVisible,
} from "@/components/use-defer-while-hidden";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import type { LogLineContract } from "@scarn/api/frontend-contracts";
import {
  openLogFeedSocket,
  type LogFeedSocket,
  type LogFeedSocketHandlers,
} from "./task-run-log-socket";

// Adaptive polling to control read-side DB/API cost. While log lines are
// actively arriving we poll at the fast interval; when a poll returns nothing
// new we back off exponentially up to the max. This collapses the (common)
// idle-while-the-agent-thinks case from a fixed high-frequency stream of empty
// queries into a trickle, while staying responsive once output resumes.
const FAST_POLL_INTERVAL_MS = 2_000;
const MAX_POLL_INTERVAL_MS = 15_000;
const POLL_BACKOFF_FACTOR = 2;

export const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

/**
 * Consecutive failed connects (closed before `open`, or closed by the feed
 * with 1008) after which the browser gives up on the socket and polls.
 */
export const MAX_FAILED_CONNECTS = 3;

const CLOSE_POLICY_VIOLATION = 1008;

/** User-facing copy when the org has exhausted its monthly log-read allowance. */
const READ_LIMIT_MESSAGE =
  "You've reached your monthly log viewing limit. Upgrade your plan to view logs again.";

const ARCHIVE_LOAD_FAILED_MESSAGE = "Couldn't load the archived logs";

/**
 * Detects the server's 402 read-cap error (`UsageLimitExceededError`, serialized
 * as a problem-details body with `status: 402` and a `USAGE_LIMIT_EXCEEDED_READ`
 * code). Treaty throws the parsed error body as the rejection value, so we match
 * on its shape rather than on an HTTP Response object.
 */
// eslint-disable-next-line local/no-unknown-parameter-type
const isReadLimitExceededError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const status = "status" in error ? error.status : undefined;
  const code = "code" in error ? error.code : undefined;
  return (
    status === 402 ||
    (typeof code === "string" && code.startsWith("USAGE_LIMIT_EXCEEDED"))
  );
};

type ScarnApiClient = ReturnType<typeof getBrowserScarnApiClient>;

export type TaskRunLogFeedState = {
  lines: LogLineContract[];
  loading: boolean;
  /** True once the feed is exhausted and (if present) the archive is loaded. */
  complete: boolean;
  error: string;
};

export type TaskRunLogFeed = {
  getState: () => TaskRunLogFeedState;
  subscribe: (listener: (state: TaskRunLogFeedState) => void) => () => void;
  dispose: () => void;
};

type LogFeedToken = { url: string; token: string };

export function startTaskRunLogFeed({
  apiClient,
  taskRunId,
  live,
  onArchived,
}: {
  apiClient: ScarnApiClient;
  taskRunId: string;
  live: boolean;
  /** Called with the archived lines once the archive loaded successfully. */
  onArchived: (lines: LogLineContract[]) => void;
}): TaskRunLogFeed {
  const controller = new AbortController();
  const isCancelled = () => controller.signal.aborted;
  const listeners = new Set<(state: TaskRunLogFeedState) => void>();
  let state: TaskRunLogFeedState = {
    lines: [],
    loading: true,
    complete: false,
    error: "",
  };
  let cursor = 0;
  let pollInterval = FAST_POLL_INTERVAL_MS;
  let reconnectAttempt = 0;
  let failedConnects = 0;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let socket: LogFeedSocket | null = null;

  const update = (patch: Partial<TaskRunLogFeedState>) => {
    if (isCancelled()) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  };

  const appendLines = (incoming: LogLineContract[]): boolean => {
    const fresh = incoming.filter((line) => line.seq > cursor);
    if (fresh.length === 0) return false;
    cursor = Math.max(cursor, ...fresh.map((line) => line.seq));
    update({ lines: [...state.lines, ...fresh] });
    return true;
  };

  const loadArchive = async (): Promise<boolean> => {
    try {
      const archive = await unwrapTreatyResponse(
        apiClient.api["task-runs"]({
          taskRunId: parseUuidV7(taskRunId),
        }).logs.archive.get(),
      );
      if (!archive.url) {
        // No presigned URL available (e.g. proxy-only stores). Skip; the feed
        // lines already shown remain the best available view.
        return true;
      }
      const response = await fetch(archive.url, {
        signal: controller.signal,
      });
      if (!response.ok) {
        update({
          error: `${ARCHIVE_LOAD_FAILED_MESSAGE} (storage responded ${String(response.status)}).`,
        });
        return false;
      }
      const text = await response.text();
      const parsed = text
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          // Archives written before levels were persisted omit `level`, so
          // parse into a shape where it may be absent and default it to `info`
          // — historical logs then never falsely flag.
          const raw = JSON.parse(line) as Omit<LogLineContract, "level"> &
            Partial<Pick<LogLineContract, "level">>;
          return {
            ...raw,
            level: raw.level ?? "info",
          } satisfies LogLineContract;
        });
      update({ lines: parsed });
      return true;
    } catch (archiveError) {
      // The org is over its monthly log-read cap (HTTP 402). The feed never
      // surfaces this because reads are only metered on the archive, so tell
      // the user explicitly instead of falling through to "No logs yet."
      if (isReadLimitExceededError(archiveError)) {
        update({ error: READ_LIMIT_MESSAGE });
        return false;
      }
      // Keep whatever feed lines we have, but say why the archive is missing
      // rather than leaving the viewer at a bare "No logs yet.". A browser
      // `fetch` rejects with a `TypeError` for network failures and for
      // responses blocked by the bucket's CORS rules.
      update({
        error:
          archiveError instanceof TypeError
            ? `${ARCHIVE_LOAD_FAILED_MESSAGE} (network or CORS error reaching storage).`
            : `${ARCHIVE_LOAD_FAILED_MESSAGE}.`,
      });
      return false;
    }
  };

  const finish = async () => {
    update({ loading: false });
    const archived = await loadArchive();
    if (isCancelled()) return;
    if (archived) onArchived(state.lines);
    update({ complete: true });
  };

  const poll = async () => {
    try {
      const result = await unwrapTreatyResponse(
        apiClient.api["task-runs"]({
          taskRunId: parseUuidV7(taskRunId),
        }).logs.get({ query: { from: cursor, limit: 1000 } }),
      );
      if (isCancelled()) return;

      if (appendLines(result.lines)) {
        pollInterval = FAST_POLL_INTERVAL_MS;
      } else {
        pollInterval = Math.min(
          pollInterval * POLL_BACKOFF_FACTOR,
          MAX_POLL_INTERVAL_MS,
        );
      }
      cursor = Math.max(cursor, result.nextOffset);
      update({ loading: false });

      if (result.complete) {
        await finish();
        return;
      }

      if (live) {
        // A hidden tab makes no requests: the timer waits for the tab to be
        // visible again, then catches up from the cursor at the fast interval.
        timeoutId = setTimeout(() => {
          void pollWhenVisible();
        }, pollInterval);
      }
    } catch (pollError) {
      if (isCancelled()) return;
      update({
        loading: false,
        error:
          pollError instanceof Error
            ? pollError.message
            : "Failed to load logs",
      });
    }
  };

  const pollWhenVisible = async () => {
    if (isPageHidden()) {
      await waitUntilVisible(controller.signal);
      if (isCancelled()) return;
      pollInterval = FAST_POLL_INTERVAL_MS;
    }
    await poll();
  };

  const fetchReadToken = async (): Promise<LogFeedToken | null> => {
    try {
      const { data, error } = await apiClient.api["task-runs"]({
        taskRunId: parseUuidV7(taskRunId),
      })["log-feed-token"].get();
      return error ? null : data;
    } catch {
      return null;
    }
  };

  const scheduleReconnect = () => {
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * POLL_BACKOFF_FACTOR ** reconnectAttempt,
      RECONNECT_MAX_DELAY_MS,
    );
    reconnectAttempt += 1;
    timeoutId = setTimeout(() => {
      void (async () => {
        if (isPageHidden()) {
          await waitUntilVisible(controller.signal);
          if (isCancelled()) return;
        }
        await connect();
      })();
    }, delay);
  };

  const connect = async () => {
    const token = await fetchReadToken();
    if (isCancelled()) return;
    if (!token) {
      await poll();
      return;
    }
    try {
      socket = openLogFeedSocket(
        { url: token.url, token: token.token, from: cursor },
        socketHandlers,
      );
    } catch {
      await poll();
    }
  };

  const socketHandlers: LogFeedSocketHandlers = {
    onLines: appendLines,
    onCaughtUp: () => {
      reconnectAttempt = 0;
      update({ loading: false });
    },
    onSealed: () => {
      socket?.close();
      socket = null;
      void finish();
    },
    onClose: ({ opened, code }) => {
      socket = null;
      if (isCancelled()) return;
      failedConnects =
        !opened || code === CLOSE_POLICY_VIOLATION ? failedConnects + 1 : 0;
      if (failedConnects >= MAX_FAILED_CONNECTS) {
        void poll();
        return;
      }
      scheduleReconnect();
    },
  };

  void (live ? connect() : poll());

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      controller.abort();
      if (timeoutId) clearTimeout(timeoutId);
      socket?.close();
      socket = null;
      listeners.clear();
    },
  };
}

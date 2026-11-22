"use client";

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { conversationEventSchema } from "@scarn/api/frontend-contracts";
import type {
  ConversationEvent,
  LogLineContract,
} from "@scarn/api/frontend-contracts";
import {
  startTaskRunLogFeed,
  type TaskRunLogFeed,
  type TaskRunLogFeedState,
} from "./task-run-log-feed";

export type TaskRunLogsData = {
  /** Raw worker/agent log lines (for the raw-logs viewer). */
  lines: LogLineContract[];
  /**
   * Parsed, de-duplicated conversation events in first-seen order. Each
   * streaming part (text/reasoning/tool) appears once, reflecting its latest
   * snapshot — OpenCode resends full parts so later versions replace earlier.
   */
  conversationEvents: ConversationEvent[];
  loading: boolean;
  /** True once the feed is exhausted and (if present) the archive is loaded. */
  complete: boolean;
  error: string;
};

/** How many complete feeds `TaskRunLogsCacheProvider` keeps, oldest evicted first. */
const CACHE_CAPACITY = 20;

type SharedFeed = { feed: TaskRunLogFeed; consumers: number };

type TaskRunLogsCache = {
  complete: Map<string, LogLineContract[]>;
  running: Map<string, SharedFeed>;
};

const TaskRunLogsCacheContext = createContext<TaskRunLogsCache | null>(null);

/**
 * Shares task log feeds by task id across every `useTaskRunLogs` under it —
 * the conversation, the Logs view, the Details drawer's summary. Consumers of
 * the same task share one in-flight feed (one socket, or one polling loop), and
 * a finished run's archive is kept once loaded so it is read once rather than
 * downloaded again on each mount (log reads are billed). Without a provider
 * each hook runs its own feed.
 */
export function TaskRunLogsCacheProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [cache] = useState<TaskRunLogsCache>(() => ({
    complete: new Map(),
    running: new Map(),
  }));
  return createElement(
    TaskRunLogsCacheContext.Provider,
    { value: cache },
    children,
  );
}

const rememberFeed = (
  cache: TaskRunLogsCache,
  taskRunId: string,
  lines: LogLineContract[],
) => {
  cache.complete.delete(taskRunId);
  cache.complete.set(taskRunId, lines);
  while (cache.complete.size > CACHE_CAPACITY) {
    const oldest = cache.complete.keys().next().value;
    if (oldest === undefined) break;
    cache.complete.delete(oldest);
  }
};

/**
 * Stable identity for upserting a conversation event. Streaming parts keep a
 * fixed `partId` across updates; messages key on their id; step-finish is one
 * per message; session errors are unique per occurrence (keyed by message text
 * + index handled by the caller via the raw line seq is unnecessary here).
 */
const conversationEventKey = (event: ConversationEvent): string => {
  switch (event.kind) {
    case "message":
      return `message:${event.id}`;
    case "text":
      return `text:${event.partId}`;
    case "reasoning":
      return `reasoning:${event.partId}`;
    case "tool":
      return `tool:${event.partId}`;
    case "step-finish":
      return `step-finish:${event.messageId}`;
    case "session-error":
      return `session-error:${event.message}`;
  }
};

const INITIAL_STATE: TaskRunLogFeedState = {
  lines: [],
  loading: false,
  complete: false,
  error: "",
};

/**
 * Follows a task's log feed while `active` (see `startTaskRunLogFeed`: the
 * feed socket when available, offset polling otherwise), then switches to the
 * durable archive once the feed is finished. Under a
 * `TaskRunLogsCacheProvider`, consumers of the same task share one feed and a
 * feed that already completed is served from the cache without any request.
 */
export function useTaskRunLogs(
  taskRunId: string | null,
  active: boolean,
): TaskRunLogsData {
  const apiClient = useMemo(() => getBrowserScarnApiClient(), []);
  const cache = useContext(TaskRunLogsCacheContext);
  const cachedLines = taskRunId ? cache?.complete.get(taskRunId) : undefined;
  const [state, setState] = useState<TaskRunLogFeedState>(INITIAL_STATE);

  useEffect(() => {
    if (!taskRunId || cache?.complete.has(taskRunId)) {
      return;
    }
    const key = `${taskRunId}:${String(active)}`;
    const start = () =>
      startTaskRunLogFeed({
        apiClient,
        taskRunId,
        live: active,
        onArchived: (lines) => {
          if (cache) rememberFeed(cache, taskRunId, lines);
        },
      });
    const shared = cache?.running.get(key) ?? {
      feed: start(),
      consumers: 0,
    };
    shared.consumers += 1;
    cache?.running.set(key, shared);

    setState(shared.feed.getState());
    const unsubscribe = shared.feed.subscribe(setState);

    return () => {
      unsubscribe();
      shared.consumers -= 1;
      if (shared.consumers > 0) return;
      shared.feed.dispose();
      if (cache?.running.get(key) === shared) cache.running.delete(key);
    };
  }, [apiClient, cache, taskRunId, active]);

  const shownLines = cachedLines ?? state.lines;

  // Project the `conversation`-stream lines into de-duplicated, ordered events.
  // Parsing happens here (not per-render in the view) and tolerates malformed
  // lines by skipping them, so one bad line can't break the transcript.
  const conversationEvents = useMemo(() => {
    const byKey = new Map<string, ConversationEvent>();
    const order: string[] = [];
    for (const line of shownLines) {
      if (line.stream !== "conversation") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line.content);
      } catch {
        continue;
      }
      const result = conversationEventSchema.safeParse(parsed);
      if (!result.success) continue;
      const key = conversationEventKey(result.data);
      if (!byKey.has(key)) {
        order.push(key);
      }
      byKey.set(key, result.data);
    }
    return order.map((key) => byKey.get(key) as ConversationEvent);
  }, [shownLines]);

  if (cachedLines) {
    return {
      lines: cachedLines,
      conversationEvents,
      loading: false,
      complete: true,
      error: "",
    };
  }
  return {
    lines: state.lines,
    conversationEvents,
    loading: state.loading,
    complete: state.complete,
    error: state.error,
  };
}

/**
 * Reader side of a task run's live log feed socket (the work-signal Durable
 * Object). Connects with a read token from a cursor, keeps the connection alive
 * with `"ping"`, and reports `lines`, `caught-up` and `sealed` messages until
 * closed. The browser never sends anything but `"ping"`: the feed refuses any
 * other message from a reader.
 */
import type { LogLineContract } from "@scarn/api/frontend-contracts";

export const LOG_FEED_PING_INTERVAL_MS = 30_000;

export type LogFeedSocketHandlers = {
  onLines: (lines: LogLineContract[]) => void;
  onCaughtUp: () => void;
  onSealed: () => void;
  /**
   * The connection dropped without `close()` being called. `opened` is false
   * when it closed before `open` (a refused upgrade looks the same as a
   * network failure: close code 1006).
   */
  onClose: (close: LogFeedSocketClose) => void;
};

export type LogFeedSocketClose = { opened: boolean; code: number };

export type LogFeedSocket = { close: () => void };

type ReaderMessage =
  | { t: "lines"; lines: LogLineContract[] }
  | { t: "caught-up" }
  | { t: "sealed" };

const parseReaderMessage = (data: string): ReaderMessage | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const message = parsed as { t?: unknown; lines?: unknown };
  if (message.t === "lines" && Array.isArray(message.lines)) {
    return { t: "lines", lines: message.lines as LogLineContract[] };
  }
  if (message.t === "caught-up") return { t: "caught-up" };
  if (message.t === "sealed") return { t: "sealed" };
  return null;
};

export function openLogFeedSocket(
  { url, token, from }: { url: string; token: string; from: number },
  handlers: LogFeedSocketHandlers,
): LogFeedSocket {
  const socketUrl = new URL(url);
  socketUrl.searchParams.set("token", token);
  socketUrl.searchParams.set("from", String(from));
  const socket = new WebSocket(socketUrl);
  let closed = false;
  let opened = false;

  socket.addEventListener("open", () => {
    opened = true;
  });

  const pingId = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) socket.send("ping");
  }, LOG_FEED_PING_INTERVAL_MS);

  socket.addEventListener("message", (event: MessageEvent) => {
    if (closed || typeof event.data !== "string") return;
    const message = parseReaderMessage(event.data);
    if (!message) return;
    switch (message.t) {
      case "lines":
        handlers.onLines(message.lines);
        return;
      case "caught-up":
        handlers.onCaughtUp();
        return;
      case "sealed":
        handlers.onSealed();
        return;
    }
  });

  socket.addEventListener("close", (event: CloseEvent) => {
    clearInterval(pingId);
    if (closed) return;
    closed = true;
    handlers.onClose({ opened, code: event.code });
  });

  return {
    close: () => {
      if (closed) return;
      closed = true;
      clearInterval(pingId);
      socket.close();
    },
  };
}

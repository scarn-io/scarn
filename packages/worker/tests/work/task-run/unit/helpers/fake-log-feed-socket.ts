/**
 * In-memory stand-in for the log feed Durable Object's WebSocket: records
 * what the worker sends and lets a test open, ack, nack or close it.
 */
import type { WorkSignalSocket } from "../../../../../src/work/task-run/infra/work-signal-client";
import type { TaskLogLine } from "../../../../../src/work/task-run/contracts/process-project-work-types";

export type AppendFrame = { t: "append"; id: number; lines: TaskLogLine[] };

export class FakeLogFeedSocket implements WorkSignalSocket {
  readyState = 0;
  readonly sent: string[] = [];
  closedWith: { code?: number | undefined } | null = null;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {}

  get appends(): AppendFrame[] {
    return this.sent
      .filter((data) => data !== "ping")
      .map((data) => JSON.parse(data) as AppendFrame);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closedWith = { code };
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  receive(message: Record<string, unknown>): void {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(message) }),
    );
  }

  ackAll(nextOffset?: number): void {
    for (const frame of this.appends) {
      this.receive({
        t: "ack",
        id: frame.id,
        nextOffset: nextOffset ?? frame.lines.at(-1)?.seq ?? 0,
      });
    }
  }

  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close", { code }));
  }
}

export function createFakeSocketFactory() {
  const sockets: FakeLogFeedSocket[] = [];
  return {
    sockets,
    createSocket: (url: string) => {
      const socket = new FakeLogFeedSocket(url);
      sockets.push(socket);
      return socket;
    },
  };
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export const hourFromNow = () => new Date(Date.now() + 3_600_000).toISOString();

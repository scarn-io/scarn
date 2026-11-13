/**
 * `TaskLogShipper` with a log feed socket: batches go over the socket while it
 * is connected, fall back to `appendTaskLogs` when it drops mid-batch, and
 * `stop()` waits for the final ack. Also covers the batch byte cap.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { createUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { SecretMasker } from "../../../../src/work/task-run/application/secret-masker";
import { TaskLogShipper } from "../../../../src/work/task-run/application/task-log-shipper";
import type { TaskLogLine } from "../../../../src/work/task-run/contracts/process-project-work-types";
import {
  createLogFeedSocket,
  type LogFeedSocket,
} from "../../../../src/work/task-run/infra/log-feed-socket";
import {
  createFakeSocketFactory,
  hourFromNow,
  waitFor,
} from "./helpers/fake-log-feed-socket";

let feed: LogFeedSocket | null = null;

afterEach(() => {
  feed?.stop();
  feed = null;
});

function setup() {
  const factory = createFakeSocketFactory();
  feed = createLogFeedSocket({
    taskRunId: "run-1",
    token: {
      url: "wss://feed.example/task-runs/run-1/ws",
      token: "token-1",
      expiresAt: hourFromNow(),
    },
    refreshToken: () => Promise.resolve(null),
    createSocket: factory.createSocket,
    minBackoffMs: 5,
    maxBackoffMs: 10,
  });
  feed.start();
  factory.sockets[0]?.open();
  const httpLines: TaskLogLine[] = [];
  const appendTaskLogs = vi.fn(
    (input: { lines: TaskLogLine[] }): Promise<{ nextOffset: number }> => {
      httpLines.push(...input.lines);
      return Promise.resolve({ nextOffset: input.lines.at(-1)?.seq ?? 0 });
    },
  );
  const shipper = new TaskLogShipper({
    workerClient: { appendTaskLogs },
    taskRunId: createUuidV7(),
    claimToken: "claim-token",
    secretMasker: new SecretMasker(),
    logFeed: feed,
    maxBatchLines: 2,
    flushIntervalMs: 60_000,
  });
  return { shipper, sockets: factory.sockets, appendTaskLogs, httpLines };
}

describe("TaskLogShipper over the log feed socket", () => {
  it("sends batches through the socket without any HTTP appends", async () => {
    const { shipper, sockets, appendTaskLogs } = setup();
    const socket = sockets[0];

    shipper.enqueue("worker", "a");
    shipper.enqueue("worker", "b");
    shipper.enqueue("worker", "c");
    const flushed = shipper.flush();
    await waitFor(() => socket?.appends.length === 1);
    socket?.ackAll();
    await waitFor(() => socket?.appends.length === 2);
    socket?.receive({ t: "ack", id: 2, nextOffset: 3 });
    await flushed;

    expect(
      socket?.appends.map((frame) => frame.lines.map((l) => l.content)),
    ).toEqual([["a", "b"], ["c"]]);
    expect(appendTaskLogs).not.toHaveBeenCalled();
  });

  it("sends the in-flight batch over HTTP when the socket drops, without loss or duplication", async () => {
    const { shipper, sockets, appendTaskLogs, httpLines } = setup();
    const socket = sockets[0];

    shipper.enqueue("worker", "a");
    shipper.enqueue("worker", "b");
    shipper.enqueue("worker", "c");
    shipper.enqueue("worker", "d");
    const flushed = shipper.flush();
    await waitFor(() => socket?.appends.length === 1);
    socket?.ackAll();
    await waitFor(() => socket?.appends.length === 2);
    socket?.serverClose(1006);
    await flushed;

    const socketAcked = socket?.appends[0]?.lines ?? [];
    expect(socketAcked.map((l) => l.seq)).toEqual([1, 2]);
    expect(appendTaskLogs).toHaveBeenCalledTimes(1);
    expect(httpLines.map((l) => l.seq)).toEqual([3, 4]);
  });

  it("stop() resolves only after the final batch is acked", async () => {
    const { shipper, sockets, appendTaskLogs } = setup();
    const socket = sockets[0];

    shipper.enqueue("worker", "last");
    let stopped = false;
    const stopping = shipper.stop().then(() => {
      stopped = true;
    });
    await waitFor(() => socket?.appends.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);

    socket?.ackAll();
    await stopping;
    expect(stopped).toBe(true);
    expect(appendTaskLogs).not.toHaveBeenCalled();
  });
});

describe("TaskLogShipper batch byte cap", () => {
  it("splits batches so each lines array stays within maxBatchBytes", async () => {
    const batches: TaskLogLine[][] = [];
    const shipper = new TaskLogShipper({
      workerClient: {
        appendTaskLogs: (input) => {
          batches.push(input.lines);
          return Promise.resolve({ nextOffset: 0 });
        },
      },
      taskRunId: createUuidV7(),
      claimToken: "claim-token",
      secretMasker: new SecretMasker(),
      maxBatchBytes: 1_000,
      flushIntervalMs: 60_000,
    });

    for (let index = 0; index < 5; index += 1) {
      shipper.enqueue("worker", "x".repeat(400));
    }
    await shipper.stop();

    expect(batches.map((batch) => batch.length)).toEqual([2, 2, 1]);
    for (const batch of batches) {
      expect(
        new TextEncoder().encode(JSON.stringify(batch)).byteLength,
      ).toBeLessThanOrEqual(1_000);
    }
  });

  it("still sends a single line larger than the cap on its own", async () => {
    const batches: TaskLogLine[][] = [];
    const shipper = new TaskLogShipper({
      workerClient: {
        appendTaskLogs: (input) => {
          batches.push(input.lines);
          return Promise.resolve({ nextOffset: 0 });
        },
      },
      taskRunId: createUuidV7(),
      claimToken: "claim-token",
      secretMasker: new SecretMasker(),
      maxBatchBytes: 100,
      flushIntervalMs: 60_000,
    });

    shipper.enqueue("worker", "y".repeat(500));
    shipper.enqueue("worker", "z");
    await shipper.stop();

    expect(batches.map((batch) => batch.length)).toEqual([1, 1]);
  });
});

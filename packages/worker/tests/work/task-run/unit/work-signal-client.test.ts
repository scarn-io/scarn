/**
 * `createWorkSignalClient` against a fake work-signal server (`Bun.serve`):
 * it wakes on every (re)connect and on `{"t":"work"}`, reconnects after the
 * server closes the socket, and stays inert when the token route 404s.
 */
import { hostname } from "node:os";
import { afterEach, describe, expect, test, vi } from "bun:test";
import type { ServerWebSocket } from "bun";
import { parseUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { runProjectWork } from "../../../../src/work/task-run/application/run-project-work";
import type { WorkEvent } from "../../../../src/work/task-run/contracts/work-reporter";
import { noopReporter } from "../../../../src/work/task-run/contracts/work-reporter";
import {
  createWorkSignalClient,
  type WorkSignalClient,
} from "../../../../src/work/task-run/infra/work-signal-client";
import {
  createRunTracker,
  createWorkerClient,
} from "./helpers/claimed-task-fixtures";

const projectId = "01966a2c-9494-7db5-aa46-0f8f5cbbe008";

type FakeSignalServer = {
  server: { stop(closeActiveConnections?: boolean): Promise<void> };
  url: string;
  sockets: ServerWebSocket<unknown>[];
  connectPaths: string[];
};

function startFakeSignalServer(): FakeSignalServer {
  const sockets: ServerWebSocket<unknown>[] = [];
  const connectPaths: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request, srv) {
      const url = new URL(request.url);
      connectPaths.push(`${url.pathname}${url.search}`);
      if (srv.upgrade(request)) {
        return undefined;
      }
      return new Response("Expected WebSocket upgrade", { status: 426 });
    },
    websocket: {
      open(ws) {
        sockets.push(ws);
      },
      message(ws, message) {
        if (message === "ping") {
          ws.send("pong");
        }
      },
    },
  });
  return {
    server,
    url: `http://localhost:${String(server.port)}`,
    sockets,
    connectPaths,
  };
}

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) {
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        reject(new Error("timed out waiting for condition"));
      } else {
        setTimeout(check, 5);
      }
    };
    check();
  });
}

function nextWake(client: WorkSignalClient, timeoutMs = 2_000) {
  const controller = new AbortController();
  return Promise.race([
    client.wake(controller.signal).then(() => "woken" as const),
    new Promise<"timeout">((resolve) =>
      setTimeout(() => {
        controller.abort();
        resolve("timeout");
      }, timeoutMs),
    ),
  ]);
}

let fake: FakeSignalServer | null = null;
let client: WorkSignalClient | null = null;

afterEach(() => {
  client?.stop();
  client = null;
  void fake?.server.stop(true);
  fake = null;
});

describe("work signal client", () => {
  test("wakes on connect and on a work message, then reconnects and wakes again after a close", async () => {
    fake = startFakeSignalServer();
    const server = fake;
    const events: WorkEvent["type"][] = [];
    let tokenCount = 0;
    client = createWorkSignalClient({
      projectId,
      fetchToken: () => {
        tokenCount += 1;
        return Promise.resolve({
          url: server.url,
          token: `token-${String(tokenCount)}`,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        });
      },
      reporter: {
        ...noopReporter,
        event: (event) => events.push(event.type),
      },
      maxWakeJitterMs: 0,
      minBackoffMs: 10,
      maxBackoffMs: 20,
    });

    expect(await client.start()).toBe(true);
    expect(await nextWake(client)).toBe("woken");
    expect(server.connectPaths[0]).toBe(
      `/projects/${projectId}/connect?token=token-1`,
    );

    server.sockets[0]?.send(JSON.stringify({ t: "work" }));
    expect(await nextWake(client)).toBe("woken");

    server.sockets[0]?.close(4001, "token expired");
    await waitFor(() => server.sockets.length === 2);
    expect(await nextWake(client)).toBe("woken");
    expect(server.connectPaths[1]).toBe(
      `/projects/${projectId}/connect?token=token-2`,
    );
    expect(events).toEqual([
      "worker:signal-connected",
      "worker:signal-disconnected",
      "worker:signal-connected",
    ]);
  });

  test("a wake that arrives while nobody waits is kept for the next call", async () => {
    fake = startFakeSignalServer();
    const server = fake;
    client = createWorkSignalClient({
      projectId,
      fetchToken: () =>
        Promise.resolve({
          url: server.url,
          token: "token",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      maxWakeJitterMs: 0,
    });

    await client.start();
    await waitFor(() => server.sockets.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await nextWake(client, 0)).toBe("woken");
    expect(await nextWake(client, 50)).toBe("timeout");
  });

  test("reports connection state and resolves disconnected() when the socket drops", async () => {
    fake = startFakeSignalServer();
    const server = fake;
    client = createWorkSignalClient({
      projectId,
      fetchToken: () =>
        Promise.resolve({
          url: server.url,
          token: "token",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      maxWakeJitterMs: 0,
      minBackoffMs: 10,
      maxBackoffMs: 20,
    });
    const connectedClient = client;

    expect(connectedClient.isConnected()).toBe(false);
    await connectedClient.disconnected(new AbortController().signal);

    await connectedClient.start();
    await waitFor(() => connectedClient.isConnected());

    const aborted = new AbortController();
    let abortedResolved = false;
    void connectedClient.disconnected(aborted.signal).then(() => {
      abortedResolved = true;
    });
    aborted.abort();

    const disconnected = connectedClient.disconnected(
      new AbortController().signal,
    );
    server.sockets[0]?.close(4001, "bye");
    await disconnected;
    expect(connectedClient.isConnected()).toBe(false);
    expect(abortedResolved).toBe(false);

    await waitFor(() => connectedClient.isConnected());
  });

  test("a 404 from the token route leaves the client inert", async () => {
    const events: WorkEvent["type"][] = [];
    const createSocket = vi.fn();
    client = createWorkSignalClient({
      projectId,
      fetchToken: () => Promise.resolve(null),
      createSocket,
      reporter: { ...noopReporter, event: (event) => events.push(event.type) },
    });

    expect(await client.start()).toBe(false);
    expect(createSocket).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});

describe("runProjectWork with push unavailable", () => {
  class StopPolling extends Error {}

  test("a 404 token response keeps the worker polling with no errors", async () => {
    let call = 0;
    const claimTaskRuns = vi.fn(() => {
      call += 1;
      return call <= 2
        ? Promise.resolve([])
        : Promise.reject(new StopPolling());
    });
    const tokenRequests: { projectId: string; workerId: string }[] = [];
    const issueWorkSignalToken = vi.fn(
      (request: { projectId: string; workerId: string }) => {
        tokenRequests.push(request);
        return Promise.resolve(null);
      },
    );
    const sleepSignals: (AbortSignal | undefined)[] = [];
    const logger = { debug: vi.fn(), log: vi.fn(), error: vi.fn() };
    const events: WorkEvent["type"][] = [];

    const run = runProjectWork(
      {
        projectId,
        baseUrl: "http://localhost:1",
        pollIntervalMs: 100,
      },
      {
        createWorkerClient: () =>
          Promise.resolve({
            ...createWorkerClient(),
            claimTaskRuns,
            issueWorkSignalToken,
          }),
        createRunTracker,
        runtimeEnvironmentOrchestrator: {
          launch: vi.fn(() => Promise.reject(new Error("launch not used"))),
        },
        agentRunner: {
          promptAsync: vi.fn(() => Promise.reject(new Error("not used"))),
          getSessionStatus: vi.fn(() => Promise.resolve({ running: false })),
          abort: vi.fn(() => Promise.resolve(undefined)),
          sendRetryPrompt: vi.fn(() => Promise.resolve(undefined)),
        },
        artifactStore: { saveArtifact: vi.fn() },
        sleep: (_milliseconds, signal) => {
          sleepSignals.push(signal);
          return Promise.resolve();
        },
        logger,
        reporter: {
          ...noopReporter,
          event: (event) => events.push(event.type),
        },
      },
    );

    try {
      await run;
      throw new Error("expected runProjectWork to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(StopPolling);
    }

    expect(tokenRequests).toEqual([
      {
        projectId: parseUuidV7(projectId),
        workerId: `scarn-work-${hostname()}-${String(process.pid)}-${projectId}`,
      },
    ]);
    expect(claimTaskRuns).toHaveBeenCalledTimes(3);
    expect(sleepSignals).toEqual([undefined, undefined]);
    expect(logger.error).not.toHaveBeenCalled();
    expect(events).not.toContain("worker:signal-connected");
    expect(events).not.toContain("worker:signal-disconnected");
  });
});

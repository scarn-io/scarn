import { describe, expect, it, vi } from "bun:test";
import { createUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { TaskLogStreaming } from "../../../../src/work/task-run/application/start-task-log-streaming";
import type {
  ProjectWorkLogger,
  TaskLogLine,
  TaskRunWorkerClient,
} from "../../../../src/work/task-run/contracts/process-project-work-types";
import {
  createFakeSocketFactory,
  hourFromNow,
  waitFor,
} from "./helpers/fake-log-feed-socket";

const silentLogger: ProjectWorkLogger = {
  debug: () => {},
  log: () => {},
  error: () => {},
};

const buildWorkerClient = (
  sink: TaskLogLine[],
): Pick<TaskRunWorkerClient, "appendTaskLogs"> => ({
  appendTaskLogs: (input) => {
    sink.push(...input.lines);
    return Promise.resolve({ nextOffset: input.lines.at(-1)?.seq ?? 0 });
  },
});

describe("TaskLogStreaming", () => {
  it("tees worker logger lines into the feed as the worker stream", async () => {
    const sent: TaskLogLine[] = [];
    const baseCalls: string[] = [];
    const baseLogger: ProjectWorkLogger = {
      debug: (scope, message) => baseCalls.push(`debug:${scope}:${message}`),
      log: (scope, message) => baseCalls.push(`log:${scope}:${message}`),
      error: (scope, message) => baseCalls.push(`error:${scope}:${message}`),
    };

    const stream = new TaskLogStreaming({
      workerClient: buildWorkerClient(sent),
      logger: baseLogger,
      taskRunId: createUuidV7(),
      claimToken: "claim-token",
    });

    stream.logger.log("worker", "starting step", { stepId: "abc" });
    stream.logger.error("health", "container unhealthy");
    await stream.shipper.flush();

    // Base sink still receives everything (CLI/file output preserved).
    expect(baseCalls).toEqual([
      "log:worker:starting step",
      "error:health:container unhealthy",
    ]);

    // Both lines were streamed as the worker stream, in order.
    const workerLines = sent.filter((line) => line.stream === "worker");
    expect(workerLines.map((line) => line.content)).toEqual([
      '[worker] starting step {"stepId":"abc"}',
      "ERROR [health] container unhealthy",
    ]);
    // The logger method maps to a structured level carried on the shipped line:
    // `log` -> info, `error` -> error.
    expect(workerLines.map((line) => line.level)).toEqual(["info", "error"]);

    await stream.stop();
  });

  it("keeps debug worker logs local but out of the shipped feed", async () => {
    const sent: TaskLogLine[] = [];
    const baseCalls: string[] = [];
    const baseLogger: ProjectWorkLogger = {
      debug: (scope, message) => baseCalls.push(`debug:${scope}:${message}`),
      log: (scope, message) => baseCalls.push(`log:${scope}:${message}`),
      error: (scope, message) => baseCalls.push(`error:${scope}:${message}`),
    };

    const stream = new TaskLogStreaming({
      workerClient: buildWorkerClient(sent),
      logger: baseLogger,
      taskRunId: createUuidV7(),
      claimToken: "claim-token",
    });

    stream.logger.debug("heartbeat", "tick");
    stream.logger.log("worker", "started");
    await stream.shipper.flush();

    // Local sink sees both; the feed only sees the info-level line.
    expect(baseCalls).toEqual(["debug:heartbeat:tick", "log:worker:started"]);
    expect(sent.map((line) => line.content)).toEqual(["[worker] started"]);

    await stream.stop();
  });

  it("serializes Error details into the streamed line", async () => {
    const sent: TaskLogLine[] = [];
    const baseLogger: ProjectWorkLogger = {
      debug: () => {},
      log: () => {},
      error: () => {},
    };

    const stream = new TaskLogStreaming({
      workerClient: buildWorkerClient(sent),
      logger: baseLogger,
      taskRunId: createUuidV7(),
      claimToken: "claim-token",
    });

    stream.logger.error("worker", "boom", { error: new Error("kaboom") });
    await stream.shipper.flush();

    const line = sent.find((entry) => entry.content.includes("boom"));
    expect(line?.content).toContain("kaboom");
    await stream.stop();
  });

  it("masks seeded secret values in shipped worker lines", async () => {
    const sent: TaskLogLine[] = [];
    const baseLogger: ProjectWorkLogger = {
      debug: () => {},
      log: () => {},
      error: () => {},
    };

    const stream = new TaskLogStreaming({
      workerClient: buildWorkerClient(sent),
      logger: baseLogger,
      taskRunId: createUuidV7(),
      claimToken: "claim-token",
      secretValues: ["seeded-secret"],
    });

    stream.logger.log("worker", "value is seeded-secret");
    await stream.shipper.flush();

    const line = sent.find((entry) => entry.stream === "worker");
    expect(line?.content).toBe("[worker] value is ***");

    await stream.stop();
  });

  it("masks values registered after construction", async () => {
    const sent: TaskLogLine[] = [];
    const baseLogger: ProjectWorkLogger = {
      debug: () => {},
      log: () => {},
      error: () => {},
    };

    const stream = new TaskLogStreaming({
      workerClient: buildWorkerClient(sent),
      logger: baseLogger,
      taskRunId: createUuidV7(),
      claimToken: "claim-token",
    });

    stream.registerSecretValues(["late-secret"]);
    stream.logger.log("worker", "token late-secret here");
    await stream.shipper.flush();

    const line = sent.find((entry) => entry.stream === "worker");
    expect(line?.content).toBe("[worker] token *** here");

    await stream.stop();
  });

  it("masks a registered setup secret echoed in a devcontainer log line", async () => {
    const sent: TaskLogLine[] = [];
    const baseLogger: ProjectWorkLogger = {
      debug: () => {},
      log: () => {},
      error: () => {},
    };

    const stream = new TaskLogStreaming({
      workerClient: buildWorkerClient(sent),
      logger: baseLogger,
      taskRunId: createUuidV7(),
      claimToken: "claim-token",
    });

    stream.registerSecretValues(["npm-setup-token"]);
    stream.shipDevcontainerLogLine(
      "initializeCommand: npm login --token=npm-setup-token",
      "info",
    );
    await stream.shipper.flush();

    expect(sent.map((line) => line.content)).toEqual([
      "[devcontainer] initializeCommand: npm login --token=***",
    ]);

    await stream.stop();
  });

  it("attaches the opencode tail at most once without throwing", async () => {
    const sent: TaskLogLine[] = [];
    const baseLogger: ProjectWorkLogger = {
      debug: () => {},
      log: () => {},
      error: () => {},
    };
    const stream = new TaskLogStreaming({
      workerClient: buildWorkerClient(sent),
      logger: baseLogger,
      taskRunId: createUuidV7(),
      claimToken: "claim-token",
    });

    // No reachable container in unit context; spawn fails silently via onError.
    stream.attachOpencodeTail({
      runtimeContainerId: "missing-container",
      opencodeLogDirectory: "/nonexistent",
    });
    // Second call is a no-op.
    stream.attachOpencodeTail({
      runtimeContainerId: "missing-container",
      opencodeLogDirectory: "/nonexistent",
    });

    await stream.stop();
  });

  it("opens no log feed socket when the claim has no log feed", async () => {
    const sent: TaskLogLine[] = [];
    const factory = createFakeSocketFactory();
    const stream = new TaskLogStreaming({
      workerClient: buildWorkerClient(sent),
      logger: silentLogger,
      taskRunId: createUuidV7(),
      claimToken: "claim-token",
      logFeed: null,
      logFeedSocketOptions: { createSocket: factory.createSocket },
    });

    stream.logger.log("worker", "over http");
    await stream.stop();

    expect(factory.sockets).toHaveLength(0);
    expect(sent.map((line) => line.content)).toEqual(["[worker] over http"]);
  });

  it("ships over the log feed socket, refreshes an expired token, and waits for the final ack on stop", async () => {
    const sent: TaskLogLine[] = [];
    const factory = createFakeSocketFactory();
    const taskRunId = createUuidV7();
    const issueLogFeedWriteToken = vi.fn(() =>
      Promise.resolve({
        url: "wss://feed.example/ws",
        token: "token-2",
        expiresAt: hourFromNow(),
      }),
    );
    const stream = new TaskLogStreaming({
      workerClient: { ...buildWorkerClient(sent), issueLogFeedWriteToken },
      logger: silentLogger,
      taskRunId,
      claimToken: "claim-token",
      logFeed: {
        url: "wss://feed.example/ws",
        token: "token-1",
        expiresAt: hourFromNow(),
      },
      logFeedSocketOptions: {
        createSocket: factory.createSocket,
        minBackoffMs: 5,
        maxBackoffMs: 10,
      },
    });
    factory.sockets[0]?.open();

    factory.sockets[0]?.serverClose(4001);
    await waitFor(() => factory.sockets.length === 2);
    expect(issueLogFeedWriteToken).toHaveBeenCalledWith({
      taskRunId,
      claimToken: "claim-token",
    });
    expect(factory.sockets[1]?.url).toBe("wss://feed.example/ws?token=token-2");
    factory.sockets[1]?.open();

    stream.logger.log("worker", "over the socket");
    let stopped = false;
    const stopping = stream.stop().then(() => {
      stopped = true;
    });
    await waitFor(() => factory.sockets[1]?.appends.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);

    factory.sockets[1]?.ackAll();
    await stopping;
    expect(sent).toHaveLength(0);
    expect(
      factory.sockets[1]?.appends[0]?.lines.map((line) => line.content),
    ).toEqual(["[worker] over the socket"]);
    expect(factory.sockets[1]?.closedWith).toEqual({ code: 1000 });
  });
});

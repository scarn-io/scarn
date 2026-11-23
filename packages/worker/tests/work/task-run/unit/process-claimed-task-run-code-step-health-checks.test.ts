/**
 * Coverage for a code step's MCP health checks in `startProcessClaimedTaskRun`
 * (ADR 0016 decision 8): they run from the worker through the MCP bridge
 * session's pool before `fn`, a failed `required` check fails the step with
 * `HealthCheckFailedError`, and `fn`'s bridged calls reuse the same pool.
 *
 * Uses the real `openMcpBridgeSession` on loopback with a fake pool factory,
 * and a fake `runCodeStepCommand` standing in for `fn` that calls the bridge
 * over HTTP with the env it was given.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "bun:test";
import type { HealthCheck } from "@scarn/sdk/health-checks";
import {
  MCP_BRIDGE_CALL_PATH,
  MCP_BRIDGE_TOKEN_ENV,
  MCP_BRIDGE_URL_ENV,
} from "@scarn/sdk/contracts/mcp-bridge";
import { startProcessClaimedTaskRun } from "../../../../src/work/task-run/application/process-claimed-task-run";
import { HealthCheckFailedError } from "../../../../src/work/task-run/application/health-check-failed-error";
import type { RunCodeStepCommand } from "../../../../src/work/task-run/application/execute-code-step";
import type { McpToolCallOutcome } from "../../../../src/work/task-run/application/mcp-tool-caller";
import { openMcpBridgeSession } from "../../../../src/runtime/mcp-bridge/infra";
import type {
  LaunchedRuntime,
  ProcessProjectWorkDeps,
} from "../../../../src/work/task-run/contracts/process-project-work-types";
import {
  noopReporter,
  type WorkEvent,
} from "../../../../src/work/task-run/contracts/work-reporter";
import {
  createFakePool,
  type FakePool,
  type FakePoolCall,
} from "../../../runtime/mcp-bridge/unit/helpers/fake-mcp-connection-pool";
import { healthCheck } from "./helpers/fake-health-check-agent";
import {
  createRecordingOrchestrator,
  createRunTracker,
  createWorkerClient,
  createWorkerContext,
  projectId,
  requestedByUserId,
  taskRunId,
} from "./helpers/claimed-task-fixtures";

const OK: McpToolCallOutcome = {
  status: "ok",
  content: [],
  structuredContent: null,
};

describe("startProcessClaimedTaskRun code step MCP health checks", () => {
  let workspacePath: string;

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function runCodeStep(input: {
    healthChecks: HealthCheck[];
    respond: (call: FakePoolCall) => McpToolCallOutcome;
    runCodeStepCommand: RunCodeStepCommand;
  }): Promise<{
    result: Promise<unknown>;
    fakePool: FakePool;
    events: WorkEvent[];
    stop: ReturnType<typeof vi.fn>;
  }> {
    workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "scarn-code-step-health-checks-"),
    );
    const mcpCalls: NonNullable<LaunchedRuntime["mcpCalls"]> = {
      servers: { db: { type: "local", command: ["pg-mcp"] } },
      env: {},
      placement: { kind: "host", workspaceDir: workspacePath },
    };
    const { launch } = createRecordingOrchestrator(workspacePath, {
      resolvedBranch: "main",
      workBranch: null,
      createdFromBranch: null,
      devcontainerConfigPath: ".devcontainer/devcontainer.json",
      runtimeContainerId: null,
      agent: null,
      aiImage: "",
      networkName: "test-network",
      mcpCalls,
    });
    const workerClient = createWorkerClient();
    workerClient.getTaskRunWorkerContext = vi.fn(() =>
      Promise.resolve(
        createWorkerContext(
          {
            kind: "inline",
            runtime: { kind: "managed", id: "bun1" },
            envJson: null,
          },
          input.healthChecks,
          {
            kind: "code",
            prompt: null,
            entrypointJson: { sourceFile: "steps/review.ts" },
          },
        ),
      ),
    );
    const fakePool = createFakePool((call) =>
      Promise.resolve(input.respond(call)),
    );
    const stop = vi.fn();
    const events: WorkEvent[] = [];
    const tracker = createRunTracker();
    const createFakeAiServer = vi.fn(() => {
      throw new Error("a code step must not start the fake-AI harness");
    });
    const deps = {
      workerClient,
      createRunTracker: () => tracker,
      runtimeEnvironmentOrchestrator: { launch },
      agentRunner: {
        promptAsync: vi.fn(),
        getSessionStatus: vi.fn(),
        abort: vi.fn(() => Promise.resolve(undefined)),
        sendRetryPrompt: vi.fn(),
      },
      artifactStore: { saveArtifact: vi.fn() },
      sleep: vi.fn(() => Promise.resolve(undefined)),
      logger: { debug: vi.fn(), log: vi.fn(), error: vi.fn() },
      reporter: {
        ...noopReporter,
        event: (event: WorkEvent) => {
          events.push(event);
        },
      },
      createFakeAiServer,
      runCodeStepCommand: input.runCodeStepCommand,
      openMcpBridgeSession: async (openInput) => {
        const session = await openMcpBridgeSession({
          ...openInput,
          bindAddress: "127.0.0.1",
          poolFactory: fakePool.factory,
        });
        return {
          ...session,
          stop: async () => {
            stop();
            await session.stop();
          },
        };
      },
    } satisfies ProcessProjectWorkDeps;

    const result = startProcessClaimedTaskRun(
      {
        projectId,
        requestedByUserId,
        claim: { task: { id: taskRunId }, claimToken: "claim-token" },
        leaseDurationSeconds: 30,
      },
      deps,
      deps.workerClient,
      tracker,
    );
    return { result, fakePool, events, stop };
  }

  test("runs the checks through the bridge's pool before fn, then fn reuses that pool", async () => {
    const toolsCalledBeforeFn: string[] = [];
    const pool: { fake?: FakePool } = {};
    const runCodeStepCommand = vi.fn<RunCodeStepCommand>(async (command) => {
      toolsCalledBeforeFn.push(...(pool.fake?.calls ?? []).map((c) => c.tool));
      const env = command.env ?? {};
      const response = await fetch(
        `${String(env[MCP_BRIDGE_URL_ENV])}${MCP_BRIDGE_CALL_PATH}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${String(env[MCP_BRIDGE_TOKEN_ENV])}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ server: "db", tool: "query", args: {} }),
        },
      );
      expect(response.status).toBe(200);
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const { result, fakePool, events, stop } = await runCodeStep({
      healthChecks: [
        healthCheck({ mcp: "db", tool: "ping", args: { deep: true } }),
      ],
      respond: () => OK,
      runCodeStepCommand,
    });
    pool.fake = fakePool;
    await result;

    expect(toolsCalledBeforeFn).toEqual(["ping"]);
    expect(
      fakePool.calls.map((call) => [call.serverKey, call.tool, call.args]),
    ).toEqual([
      ["db", "ping", { deep: true }],
      ["db", "query", {}],
    ]);
    expect(fakePool.closeAllCount()).toBe(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(
      events.some((event) => event.type === "task:health-checks-running"),
    ).toBe(true);
  });

  test("a failed required check fails the step before fn starts and stops the bridge", async () => {
    const runCodeStepCommand = vi.fn<RunCodeStepCommand>(() =>
      Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    );

    const { result, fakePool, stop } = await runCodeStep({
      healthChecks: [healthCheck({ mcp: "db", tool: "ping" })],
      respond: () => ({
        status: "unavailable",
        reason: "start",
        detail: "spawn pg-mcp ENOENT",
      }),
      runCodeStepCommand,
    });

    let error: Error | undefined;
    try {
      await result;
    } catch (caught) {
      error = caught as Error;
    }
    expect(error).toBeInstanceOf(HealthCheckFailedError);
    expect(error?.message).toContain("db_ping");
    expect(error?.message).toContain("spawn pg-mcp ENOENT");
    expect(runCodeStepCommand).not.toHaveBeenCalled();
    expect(fakePool.closeAllCount()).toBe(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test("a failed warn check is only logged and fn still runs", async () => {
    const runCodeStepCommand = vi.fn<RunCodeStepCommand>(() =>
      Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    );

    const { result, stop } = await runCodeStep({
      healthChecks: [
        healthCheck({ mcp: "db", tool: "ping", severity: "warn" }),
      ],
      respond: () => ({ status: "timeout" }),
      runCodeStepCommand,
    });
    await result;

    expect(runCodeStepCommand).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

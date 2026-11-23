/**
 * Coverage for the MCP bridge wiring in `startProcessClaimedTaskRun`'s
 * `kind === "code"` branch (`process-claimed-task-run.ts`): a step whose
 * launch carries `mcpCalls` gets a bridge session opened, its env handed to
 * the injected `runCodeStepCommand` only, its token masked, and the bridge
 * stopped whether the step succeeds or fails. Injects fakes for both the
 * command runner and `openMcpBridgeSession`, so nothing shells out or binds a
 * real port.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "bun:test";
import { startProcessClaimedTaskRun } from "../../../../src/work/task-run/application/process-claimed-task-run";
import type { RunCodeStepCommand } from "../../../../src/work/task-run/application/execute-code-step";
import { RunRegistry } from "../../../../src/work/task-run/application/run-registry";
import type {
  McpBridgeSession,
  OpenMcpBridgeSessionInput,
} from "../../../../src/runtime/mcp-bridge/infra";
import type { LaunchedRuntime } from "../../../../src/work/task-run/contracts/process-project-work-types";
import {
  projectId,
  requestedByUserId,
  taskRunId,
} from "./helpers/claimed-task-fixtures";
import { buildCodeStepDeps } from "./helpers/code-step-deps";

describe("startProcessClaimedTaskRun kind: 'code' MCP bridge", () => {
  let workspacePath: string;

  afterEach(async () => {
    if (workspacePath) {
      await rm(workspacePath, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  test("opens an MCP bridge for a step with mcpCalls, hands its env to the runner only, masks its token, and stops it", async () => {
    workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "scarn-code-step-branch-bridge-"),
    );
    const mcpCalls: NonNullable<LaunchedRuntime["mcpCalls"]> = {
      servers: { db: { type: "local", command: ["pg-mcp"] } },
      env: { DB_URL: "postgres://db" },
      placement: {
        kind: "container",
        containerId: "runtime-container-id",
        workspaceDir: "/workspaces/repo",
      },
    };
    const stop = vi.fn(() => Promise.resolve());
    let openInput: OpenMcpBridgeSessionInput | undefined;
    const openMcpBridgeSession = vi.fn(
      (input: OpenMcpBridgeSessionInput): Promise<McpBridgeSession> => {
        openInput = input;
        return Promise.resolve({
          endpoint: "http://host.docker.internal:4321",
          token: "bridge-token-value",
          runArgs: [],
          pool: { call: vi.fn() },
          stop,
        });
      },
    );
    const runCodeStepCommand = vi.fn<RunCodeStepCommand>(() => {
      expect(stop).not.toHaveBeenCalled();
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    });
    const { deps, tracker } = buildCodeStepDeps({
      workspacePath,
      entrypointJson: { sourceFile: "steps/review.ts" },
      runCodeStepCommand,
      mcpCalls,
      openMcpBridgeSession,
    });
    const logStream = {
      registerSecretValues: vi.fn(),
      attachOpencodeTail: vi.fn(),
      attachConversationStream: vi.fn(),
      shipDevcontainerLogLine: vi.fn(),
    };
    let runSignal: AbortSignal | undefined;

    await new RunRegistry().start({ taskRunId, projectId }, async (run) => {
      runSignal = run.signal;
      await startProcessClaimedTaskRun(
        {
          projectId,
          requestedByUserId,
          claim: {
            task: { id: taskRunId },
            claimToken: "claim-token",
          },
          leaseDurationSeconds: 30,
          run,
        },
        deps,
        deps.workerClient,
        tracker,
        logStream,
      );
    });

    expect(openMcpBridgeSession).toHaveBeenCalledTimes(1);
    expect(openInput?.servers).toEqual(mcpCalls.servers);
    expect(openInput?.env).toEqual(mcpCalls.env);
    expect(openInput?.placement).toEqual(mcpCalls.placement);
    expect(openInput?.signal).toBe(runSignal);
    expect(logStream.registerSecretValues).toHaveBeenCalledWith([
      "bridge-token-value",
    ]);
    expect(runCodeStepCommand.mock.calls[0]?.[0].env).toEqual({
      SCARN_MCP_BRIDGE_URL: "http://host.docker.internal:4321",
      SCARN_MCP_BRIDGE_TOKEN: "bridge-token-value",
    });
    expect(runCodeStepCommand.mock.calls[0]?.[0].shellCommand).not.toContain(
      "bridge-token-value",
    );
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test("stops the MCP bridge when the code step fails", async () => {
    workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "scarn-code-step-branch-bridge-fail-"),
    );
    const stop = vi.fn(() => Promise.resolve());
    const { deps, tracker } = buildCodeStepDeps({
      workspacePath,
      entrypointJson: { sourceFile: "steps/review.ts" },
      runCodeStepCommand: () =>
        Promise.resolve({ exitCode: 1, stdout: "", stderr: "boom" }),
      mcpCalls: {
        servers: { db: { type: "local", command: ["pg-mcp"] } },
        env: {},
        placement: { kind: "host", workspaceDir: workspacePath },
      },
      openMcpBridgeSession: () =>
        Promise.resolve({
          endpoint: "http://127.0.0.1:4321",
          token: "bridge-token-value",
          runArgs: [],
          pool: { call: vi.fn() },
          stop,
        }),
    });

    let caught: unknown;
    try {
      await startProcessClaimedTaskRun(
        {
          projectId,
          requestedByUserId,
          claim: {
            task: { id: taskRunId },
            claimToken: "claim-token",
          },
          leaseDurationSeconds: 30,
        },
        deps,
        deps.workerClient,
        tracker,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test("opens no MCP bridge for a step without mcpCalls", async () => {
    workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "scarn-code-step-branch-no-bridge-"),
    );
    const openMcpBridgeSession = vi.fn(() =>
      Promise.reject(new Error("must not open a bridge")),
    );
    const runCodeStepCommand = vi.fn<RunCodeStepCommand>(() =>
      Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    );
    const { deps, tracker } = buildCodeStepDeps({
      workspacePath,
      entrypointJson: { sourceFile: "steps/review.ts" },
      runCodeStepCommand,
      openMcpBridgeSession,
    });

    await startProcessClaimedTaskRun(
      {
        projectId,
        requestedByUserId,
        claim: {
          task: { id: taskRunId },
          claimToken: "claim-token",
        },
        leaseDurationSeconds: 30,
      },
      deps,
      deps.workerClient,
      tracker,
    );

    expect(openMcpBridgeSession).not.toHaveBeenCalled();
    expect(runCodeStepCommand.mock.calls[0]?.[0].env ?? {}).not.toHaveProperty(
      "SCARN_MCP_BRIDGE_TOKEN",
    );
  });
});

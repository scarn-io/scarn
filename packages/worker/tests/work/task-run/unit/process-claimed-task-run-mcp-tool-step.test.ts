/**
 * A claimed `mcp_tool` run calls its tool from the worker process and leaves
 * the result as the findings submission, with no agent prompted.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "bun:test";
import { startProcessClaimedTaskRun } from "../../../../src/work/task-run/application/process-claimed-task-run";
import { buildFindingsSubmissionPath } from "../../../../src/work/task-run/application/process-project-work-findings";
import {
  taskKindInstallsPipelineBuilder,
  taskKindResolvesMcpServers,
  taskKindUsesAgent,
} from "../../../../src/work/task-run/application/task-kind-runtime";
import type { ProcessProjectWorkDeps } from "../../../../src/work/task-run/contracts/process-project-work-types";
import {
  createMcpToolStepWorkerContext,
  createRecordingOrchestrator,
  createRunTracker,
  createWorkerClient,
  projectId,
  requestedByUserId,
  taskRunId,
} from "./helpers/claimed-task-fixtures";

describe("startProcessClaimedTaskRun kind: 'mcp_tool'", () => {
  let workspacePath: string;

  afterEach(async () => {
    if (workspacePath) {
      await rm(workspacePath, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  test("an mcp_tool task doesn't use an agent", () => {
    expect(taskKindUsesAgent("mcp_tool")).toBe(false);
  });

  test("an mcp_tool task resolves MCP servers and installs no pipeline builder", () => {
    expect(taskKindResolvesMcpServers("mcp_tool")).toBe(true);
    expect(taskKindInstallsPipelineBuilder("mcp_tool")).toBe(false);
  });

  test("calls the tool and writes its result as findings without prompting an agent", async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), "scarn-mcp-tool-"));
    const workerClient = createWorkerClient();
    workerClient.getTaskRunWorkerContext = vi.fn(() =>
      Promise.resolve(createMcpToolStepWorkerContext()),
    );
    const { launch } = createRecordingOrchestrator(workspacePath, {
      resolvedBranch: "main",
      workBranch: null,
      createdFromBranch: null,
      devcontainerConfigPath: ".devcontainer/devcontainer.json",
      runtimeContainerId: "runtime-container-id",
      agent: null,
      aiImage: "",
      networkName: "test-network",
      mcpTool: {
        servers: {
          notion: { type: "remote", url: "https://mcp.notion.example/mcp" },
        },
        env: {},
        placement: {
          kind: "container",
          containerId: "runtime-container-id",
          workspaceDir: "/workspaces/repo",
        },
      },
    });
    const markFailed = vi.fn(() => Promise.resolve(undefined));
    const tracker = { ...createRunTracker(), markFailed };
    const promptAsync = vi.fn(() =>
      Promise.reject(new Error("must not be called")),
    );
    const mcpToolCaller = {
      call: vi.fn(() =>
        Promise.resolve({
          status: "ok" as const,
          content: [{ type: "text", text: "1 page" }],
          structuredContent: null,
        }),
      ),
    };
    const runCodeStepCommand = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    );
    const deps = {
      workerClient,
      createRunTracker: () => tracker,
      runtimeEnvironmentOrchestrator: { launch },
      agentRunner: {
        promptAsync,
        getSessionStatus: vi.fn(),
        abort: vi.fn(() => Promise.resolve(undefined)),
        sendRetryPrompt: vi.fn(),
      },
      artifactStore: { saveArtifact: vi.fn() },
      sleep: vi.fn(() => Promise.resolve(undefined)),
      logger: { debug: vi.fn(), log: vi.fn(), error: vi.fn() },
      runCodeStepCommand,
      mcpToolCaller,
    } satisfies ProcessProjectWorkDeps;

    const startedTask = await startProcessClaimedTaskRun(
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

    expect(startedTask.agentSessionId).toBeNull();
    expect(mcpToolCaller.call).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "search",
        args: { query: "Checkout bug" },
      }),
    );
    const submission: unknown = JSON.parse(
      await readFile(buildFindingsSubmissionPath(workspacePath), "utf8"),
    );
    expect(submission).toEqual({
      findingsJson: {
        content: [{ type: "text", text: "1 page" }],
        structuredContent: null,
      },
    });
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ taskKind: "mcp_tool", startAgent: false }),
    );
    expect(promptAsync).not.toHaveBeenCalled();
    expect(runCodeStepCommand).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
  });
});

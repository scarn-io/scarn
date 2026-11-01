import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "bun:test";
import {
  appendWorkItemChange,
  type WorkItemChange,
} from "@scarn/sdk/contracts/work-item-changes";
import { parseUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { agentReachableBaseUrl } from "../../../../src/work/task-run/application/process-claimed-task-run-launch";
import {
  buildCurrentExecutionInfoPath,
  buildFindingsSubmissionPath,
  tryPersistAgentFindings,
  writeCurrentExecutionInfoFile,
} from "../../../../src/work/task-run/application/process-project-work-findings";
import type {
  ProcessProjectWorkDeps,
  StartedClaimedTask,
} from "../../../../src/work/task-run/contracts/process-project-work-types";

const TASK_RUN_ID = parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe003");

function createStartedTask(workspacePath: string): StartedClaimedTask {
  return {
    projectId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe001"),
    localRuntimeSessionId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe002"),
    taskRunId: TASK_RUN_ID,
    claimToken: "claim-token",
    agentSessionId: "agent-session-id",
    environment: {
      workspacePath,
      workspaceFolder: "/workspaces/repo",
      resolvedBranch: "main",
      workBranch: null,
      createdFromBranch: null,
      devcontainerConfigPath: ".devcontainer/devcontainer.json",
      runtimeContainerId: "runtime-container-id",
      agent: {
        baseUrl: "http://localhost:4096",
        password: "test-password",
        version: "0.0.0-test",
        logDirectory: path.join(workspacePath, ".logs"),
      },
      aiImage: "scarn/ai-worker:local",
      networkName: "test-network",
      secretValues: [],
      cleanup: () => Promise.resolve(),
    },
  };
}

function createDeps(
  completeTaskRun: ProcessProjectWorkDeps["workerClient"]["completeTaskRun"],
): ProcessProjectWorkDeps {
  return {
    workerClient: {
      userId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe004"),
      claimTaskRuns: vi.fn(),
      heartbeatTaskRun: vi.fn(),
      failTaskRun: vi.fn(),
      completeTaskRun,
      yieldTaskRun: vi.fn(),
      appendTaskLogs: vi.fn(() => Promise.resolve({ nextOffset: 0 })),
      getTaskRun: vi.fn(),
      getTaskRunWorkerContext: vi.fn(),
      createArtifactUploadUrl: vi.fn(),
      createSessionUploadUrl: vi.fn(),
      recordArtifact: vi.fn(),
      recordArtifactFailure: vi.fn(),
    },
    createRunTracker: vi.fn(),
    runtimeEnvironmentOrchestrator: { launch: vi.fn() },
    agentRunner: {
      promptAsync: vi.fn(),
      getSessionStatus: vi.fn(),
      sendRetryPrompt: vi.fn(),
    },
    artifactStore: { saveArtifact: vi.fn() },
    sleep: vi.fn(),
  };
}

async function prepareSubmittedWorkspace(): Promise<string> {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "scarn-work-item-changes-"),
  );
  await writeCurrentExecutionInfoFile(workspacePath, {
    taskRunId: TASK_RUN_ID,
    resultSchemaJson: {
      type: "object",
      required: ["summary"],
      properties: { summary: { type: "string" } },
    },
    turnsRemaining: null,
  });
  await writeFile(
    buildFindingsSubmissionPath(workspacePath),
    `${JSON.stringify({ findingsJson: { summary: "done" } })}\n`,
    "utf8",
  );
  return workspacePath;
}

describe("work item changes sent with completion", () => {
  test.concurrent(
    "sends the recorded changes with the completion",
    async () => {
      const workspacePath = await prepareSubmittedWorkspace();
      const changes: WorkItemChange[] = [
        { kind: "comment", workItemId: "wi-1", body: "Found the cause." },
        {
          kind: "close",
          workItemId: "wi-1",
          reason: "completed",
          resolution: null,
        },
      ];
      for (const change of changes) {
        await appendWorkItemChange(workspacePath, change);
      }
      const completeTaskRun = vi.fn(() => Promise.resolve(undefined));

      const result = await tryPersistAgentFindings(
        createDeps(completeTaskRun),
        createStartedTask(workspacePath),
      );

      expect(result).toBe("submitted");
      expect(completeTaskRun).toHaveBeenCalledWith(
        expect.objectContaining({ workItemChanges: changes }),
      );
    },
  );

  test.concurrent("sends no changes when the agent recorded none", async () => {
    const workspacePath = await prepareSubmittedWorkspace();
    const completeTaskRun = vi.fn(() => Promise.resolve(undefined));

    await tryPersistAgentFindings(
      createDeps(completeTaskRun),
      createStartedTask(workspacePath),
    );

    expect(completeTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({ workItemChanges: [] }),
    );
  });
});

describe("current execution info for the work item tools", () => {
  test.concurrent(
    "writes the work item, its permissions and the API access",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "scarn-current-execution-work-item-"),
      );

      await writeCurrentExecutionInfoFile(workspacePath, {
        taskRunId: "task-id",
        resultSchemaJson: null,
        turnsRemaining: 1,
        workItemId: "wi-1",
        workItemPermissions: ["self", "children"],
        api: { baseUrl: "https://scarn.example", claimToken: "claim-token" },
      });

      expect(
        JSON.parse(
          await readFile(buildCurrentExecutionInfoPath(workspacePath), "utf8"),
        ),
      ).toEqual({
        taskRunId: "task-id",
        resultSchemaJson: null,
        turnsRemaining: 1,
        workItemId: "wi-1",
        workItemPermissions: ["self", "children"],
        api: { baseUrl: "https://scarn.example", claimToken: "claim-token" },
      });
    },
  );
});

describe("agentReachableBaseUrl", () => {
  test("points a devcontainer at the host for a loopback API", () => {
    expect(agentReachableBaseUrl("http://localhost:3000", "workspace")).toBe(
      "http://host.docker.internal:3000",
    );
    expect(agentReachableBaseUrl("http://127.0.0.1:3000/", "workspace")).toBe(
      "http://host.docker.internal:3000",
    );
  });

  test("keeps a remote API and host runs as they are", () => {
    expect(agentReachableBaseUrl("https://scarn.example", "workspace")).toBe(
      "https://scarn.example",
    );
    expect(agentReachableBaseUrl("http://localhost:3000", "no_workspace")).toBe(
      "http://localhost:3000",
    );
  });
});

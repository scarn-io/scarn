/**
 * How a claimed chat run hands its commit pin to the launch: a run with a
 * conversation id gets a repo context whose pin reports through the
 * claim-authenticated endpoint, and the worker's source branch and the run's
 * base branch are not passed on.
 */
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "bun:test";
import { startProcessClaimedTaskRun } from "../../../../src/work/task-run/application/process-claimed-task-run";
import type {
  RepoContextLaunchInput,
  TaskRunWorkerClient,
} from "../../../../src/work/task-run/contracts/process-project-work-types";
import {
  createRecordingOrchestrator,
  createRoutingDeps,
  createRunTracker,
  createWorkerClient,
  createWorkerContext,
  projectId,
  requestedByUserId,
  taskRunId,
} from "./helpers/claimed-task-fixtures";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

async function launchClaim(input: {
  conversationId: string | null;
  baseCommit: string | null;
  baseWorkBranch?: string | null;
}) {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "scarn-claimed-chat-"),
  );
  const { launch } = createRecordingOrchestrator(workspacePath, {
    resolvedBranch: "main",
    devcontainerConfigPath: ".devcontainer/devcontainer.json",
    runtimeContainerId: "runtime-container-id",
    aiImage: "scarn/ai-worker:local",
    networkName: "test-network",
  });
  const workerClient = createWorkerClient();
  const context = createWorkerContext();
  workerClient.getTaskRunWorkerContext = vi.fn(() =>
    Promise.resolve({
      ...context,
      task: { ...context.task, conversationId: input.conversationId },
      baseCommit: input.baseCommit,
      baseWorkBranch: input.baseWorkBranch ?? null,
    }),
  );
  const reportTaskRunBaseCommit = vi.fn<
    TaskRunWorkerClient["reportTaskRunBaseCommit"]
  >(() => Promise.resolve({ baseCommit: COMMIT_B, baseBranch: "main" }));
  workerClient.reportTaskRunBaseCommit = reportTaskRunBaseCommit;
  const deps = createRoutingDeps({
    workerClient,
    workspaceOrchestrator: { launch },
  });

  await startProcessClaimedTaskRun(
    {
      projectId,
      requestedByUserId,
      claim: { task: { id: taskRunId }, claimToken: "claim-token" },
      leaseDurationSeconds: 30,
      sourceBranch: "worker-local-branch",
    },
    deps,
    deps.workerClient,
    createRunTracker(),
  );

  const launchInput = (launch.mock.calls as unknown[][])[0]?.[0] as {
    sourceBranch?: string | null;
    baseWorkBranch?: string | null;
    repoContext?: RepoContextLaunchInput;
  };
  return { launchInput, reportTaskRunBaseCommit };
}

describe("startProcessClaimedTaskRun repo context", () => {
  test("a first chat run pins through the endpoint and uses the stored commit", async () => {
    const { launchInput, reportTaskRunBaseCommit } = await launchClaim({
      conversationId: "01966a2c-9494-7db5-aa46-0f8f5cbbe0c0",
      baseCommit: null,
    });

    expect(launchInput.sourceBranch).toBeNull();
    expect(launchInput.baseWorkBranch).toBeNull();
    expect(launchInput.repoContext?.baseCommit).toBeNull();
    const stored = await launchInput.repoContext?.pinBaseCommit({
      baseCommit: COMMIT_A,
      baseBranch: "main",
    });
    expect(stored).toBe(COMMIT_B);
    expect(reportTaskRunBaseCommit).toHaveBeenCalledWith({
      taskRunId,
      claimToken: "claim-token",
      baseCommit: COMMIT_A,
      baseBranch: "main",
    });
  });

  test("a retried chat run that already pinned passes the pin through", async () => {
    const { launchInput, reportTaskRunBaseCommit } = await launchClaim({
      conversationId: "01966a2c-9494-7db5-aa46-0f8f5cbbe0c0",
      baseCommit: COMMIT_A,
      baseWorkBranch: "main",
    });

    expect(launchInput.repoContext?.baseCommit).toBe(COMMIT_A);
    expect(launchInput.baseWorkBranch).toBeNull();
    expect(reportTaskRunBaseCommit).not.toHaveBeenCalled();
  });

  test("a non-chat run has no repo context and keeps its branches", async () => {
    const { launchInput } = await launchClaim({
      conversationId: null,
      baseCommit: null,
      baseWorkBranch: "scarn/prev-step",
    });

    expect(launchInput.repoContext).toBeUndefined();
    expect(launchInput.sourceBranch).toBe("worker-local-branch");
    expect(launchInput.baseWorkBranch).toBe("scarn/prev-step");
  });
});

import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "bun:test";
import { captureRejection } from "../../../support/capture-rejection";
import { parseUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import {
  buildCurrentExecutionInfoPath,
  buildFindingsSubmissionPath,
  removeFindingsSubmissionFile,
  tryPersistAgentFindings,
  writeCurrentExecutionInfoFile,
} from "../../../../src/work/task-run/application/process-project-work-findings";
import type {
  ProcessProjectWorkDeps,
  StartedClaimedTask,
} from "../../../../src/work/task-run/contracts/process-project-work-types";

type CommitAndPushWorkBranch = NonNullable<
  StartedClaimedTask["environment"]["commitAndPushWorkBranch"]
>;

function createStartedTask(
  workspacePath: string,
  overrides?: {
    workBranch?: string | null;
    createdFromBranch?: string | null;
    commitAndPushWorkBranch?: CommitAndPushWorkBranch | undefined;
  },
): StartedClaimedTask {
  const started = createBaseStartedTask(workspacePath);
  return {
    ...started,
    environment: {
      ...started.environment,
      workBranch: overrides?.workBranch ?? started.environment.workBranch,
      createdFromBranch:
        overrides?.createdFromBranch ?? started.environment.createdFromBranch,
      commitAndPushWorkBranch: overrides?.commitAndPushWorkBranch,
    },
  };
}

function createBaseStartedTask(workspacePath: string): StartedClaimedTask {
  return {
    projectId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe001"),
    localRuntimeSessionId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe002"),
    taskRunId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe003"),
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

async function writeSummarySubmission(startedTask: StartedClaimedTask) {
  const { workspacePath } = startedTask.environment;
  await writeCurrentExecutionInfoFile(workspacePath, {
    taskRunId: startedTask.taskRunId,
    resultSchemaJson: {
      type: "object",
      required: ["summary"],
      additionalProperties: false,
      properties: { summary: { type: "string" } },
    },
    turnsRemaining: null,
  });
  await writeFile(
    buildFindingsSubmissionPath(workspacePath),
    `${JSON.stringify({ findingsJson: { summary: "done" } }, null, 2)}\n`,
    "utf8",
  );
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
    runtimeEnvironmentOrchestrator: {
      launch: vi.fn(),
    },
    agentRunner: {
      promptAsync: vi.fn(),
      getSessionStatus: vi.fn(),
      sendRetryPrompt: vi.fn(),
    },
    artifactStore: {
      saveArtifact: vi.fn(),
    },
    sleep: vi.fn(),
  };
}

describe("processProjectWork findings persistence", () => {
  test.concurrent(
    "removeFindingsSubmissionFile deletes a leftover submission file",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "scarn-findings-cleanup-"),
      );
      const submissionPath = buildFindingsSubmissionPath(workspacePath);
      await mkdir(path.dirname(submissionPath), { recursive: true });
      await writeFile(
        submissionPath,
        `${JSON.stringify({ findingsJson: { summary: "stale" } }, null, 2)}\n`,
        "utf8",
      );

      await removeFindingsSubmissionFile(workspacePath);

      const stillExists = await access(submissionPath)
        .then(() => true)
        .catch(() => false);
      expect(stillExists).toBe(false);
    },
  );

  test.concurrent(
    "removeFindingsSubmissionFile is a no-op when no submission file exists",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "scarn-findings-cleanup-missing-"),
      );

      // Must not throw when the submission file was never written.
      let threw = false;
      try {
        await removeFindingsSubmissionFile(workspacePath);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    },
  );

  test.concurrent(
    "writes current execution metadata and gitignore into .scarn/current-execution",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "scarn-current-execution-"),
      );

      const currentExecutionInfoPath = await writeCurrentExecutionInfoFile(
        workspacePath,
        {
          taskRunId: "task-id",
          resultSchemaJson: {
            type: "object",
            required: ["summary"],
            properties: {
              summary: { type: "string" },
            },
          },
          turnsRemaining: 2,
        },
      );

      expect(currentExecutionInfoPath).toBe(
        buildCurrentExecutionInfoPath(workspacePath),
      );

      expect(
        JSON.parse(
          await readFile(buildCurrentExecutionInfoPath(workspacePath), "utf8"),
        ),
      ).toEqual({
        taskRunId: "task-id",
        resultSchemaJson: {
          type: "object",
          required: ["summary"],
          properties: {
            summary: { type: "string" },
          },
        },
        turnsRemaining: 2,
        workItemId: null,
        workItemPermissions: [],
        api: null,
      });
      expect(
        await readFile(
          path.join(workspacePath, ".scarn/current-execution/.gitignore"),
          "utf8",
        ),
      ).toBe("*\n.*\n!.gitignore\n");
    },
  );

  test.concurrent(
    "completes the step when findings match the stored current execution schema",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "scarn-findings-submit-"),
      );
      const startedTask = createStartedTask(workspacePath);
      const completeTaskRun = vi.fn(() => Promise.resolve(undefined));

      await writeCurrentExecutionInfoFile(workspacePath, {
        taskRunId: startedTask.taskRunId,
        resultSchemaJson: {
          type: "object",
          required: ["summary"],
          additionalProperties: false,
          properties: {
            summary: { type: "string" },
          },
        },
        turnsRemaining: null,
      });
      await writeFile(
        buildFindingsSubmissionPath(workspacePath),
        `${JSON.stringify({ findingsJson: { summary: "done" } }, null, 2)}\n`,
        "utf8",
      );

      const result = await tryPersistAgentFindings(
        createDeps(completeTaskRun),
        startedTask,
      );

      expect(result).toBe("submitted");
      expect(completeTaskRun).toHaveBeenCalledWith({
        taskRunId: startedTask.taskRunId,
        claimToken: startedTask.claimToken,
        resultJson: { summary: "done" },
        errorJson: null,
        // Branch-per-step fields are sent as dedicated fields; null here since
        // the fixture env has no work branch.
        workBranch: null,
        createdFromBranch: null,
        sessionRestored: null,
        workItemChanges: [],
      });
      const submissionStillExists = await access(
        buildFindingsSubmissionPath(workspacePath),
      )
        .then(() => true)
        .catch(() => false);
      expect(submissionStillExists).toBe(false);
    },
  );

  test.concurrent(
    "throws when findings are submitted without current execution metadata",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "scarn-findings-missing-metadata-"),
      );
      const startedTask = createStartedTask(workspacePath);
      await mkdir(path.dirname(buildFindingsSubmissionPath(workspacePath)), {
        recursive: true,
      });

      await writeFile(
        buildFindingsSubmissionPath(workspacePath),
        `${JSON.stringify({ findingsJson: { summary: "done" } }, null, 2)}\n`,
        "utf8",
      );

      try {
        await tryPersistAgentFindings(
          createDeps(vi.fn(() => Promise.resolve(undefined))),
          startedTask,
        );
        throw new Error("Expected missing current execution metadata to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(
          "Current execution metadata file not found",
        );
      }
    },
  );

  test.concurrent(
    "commits + pushes the work branch (via onBeforeComplete) BEFORE completing, and forwards the branch fields",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "scarn-findings-branch-"),
      );
      const order: string[] = [];
      const commitAndPushWorkBranch = vi.fn<CommitAndPushWorkBranch>(() => {
        order.push("commitAndPush");
        return Promise.resolve({ pushed: true });
      });
      const startedTask = createStartedTask(workspacePath, {
        workBranch: "scarn/step-abc",
        createdFromBranch: "main",
        commitAndPushWorkBranch,
      });
      const completeTaskRun = vi.fn(() => {
        order.push("complete");
        return Promise.resolve(undefined);
      });
      await writeSummarySubmission(startedTask);

      const result = await tryPersistAgentFindings(
        createDeps(completeTaskRun),
        startedTask,
        {
          onBeforeComplete: ({ findingsJson }) =>
            startedTask.environment.commitAndPushWorkBranch?.({
              result: findingsJson,
            }) ?? Promise.resolve(undefined),
        },
      );

      expect(result).toBe("submitted");
      // The commit/push ran while the workspace still existed and the step was
      // still "running" — i.e. strictly before completion.
      expect(order).toEqual(["commitAndPush", "complete"]);
      expect(commitAndPushWorkBranch).toHaveBeenCalledTimes(1);
      expect(commitAndPushWorkBranch).toHaveBeenCalledWith({
        result: { summary: "done" },
      });
      expect(completeTaskRun).toHaveBeenCalledWith({
        taskRunId: startedTask.taskRunId,
        claimToken: startedTask.claimToken,
        resultJson: { summary: "done" },
        errorJson: null,
        workBranch: "scarn/step-abc",
        createdFromBranch: "main",
        sessionRestored: null,
        workItemChanges: [],
      });
    },
  );

  test.concurrent(
    "reports a null workBranch (keeping createdFromBranch) when the push failed under onPushFailure warn",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "scarn-findings-push-warn-"),
      );
      const commitAndPushWorkBranch = vi.fn<CommitAndPushWorkBranch>(() =>
        Promise.resolve({ pushed: false }),
      );
      const startedTask = createStartedTask(workspacePath, {
        workBranch: "scarn/step-warn",
        createdFromBranch: "main",
        commitAndPushWorkBranch,
      });
      const completeTaskRun = vi.fn(() => Promise.resolve(undefined));
      await writeSummarySubmission(startedTask);

      const result = await tryPersistAgentFindings(
        createDeps(completeTaskRun),
        startedTask,
        {
          onBeforeComplete: ({ findingsJson }) =>
            startedTask.environment.commitAndPushWorkBranch?.({
              result: findingsJson,
            }) ?? Promise.resolve(undefined),
        },
      );

      expect(result).toBe("submitted");
      expect(completeTaskRun).toHaveBeenCalledWith({
        taskRunId: startedTask.taskRunId,
        claimToken: startedTask.claimToken,
        resultJson: { summary: "done" },
        errorJson: null,
        workBranch: null,
        createdFromBranch: "main",
        sessionRestored: null,
        workItemChanges: [],
      });
    },
  );

  test.concurrent(
    "a throwing commit/push closure (push failure under onPushFailure fail) aborts completion",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(os.tmpdir(), "scarn-findings-push-fail-"),
      );
      const commitAndPushWorkBranch = vi.fn<CommitAndPushWorkBranch>(() =>
        Promise.reject(new Error("Failed to push work branch")),
      );
      const startedTask = createStartedTask(workspacePath, {
        workBranch: "scarn/step-xyz",
        createdFromBranch: "main",
        commitAndPushWorkBranch,
      });
      const completeTaskRun = vi.fn(() => Promise.resolve(undefined));
      await writeSummarySubmission(startedTask);

      const failure = await captureRejection(
        tryPersistAgentFindings(createDeps(completeTaskRun), startedTask, {
          onBeforeComplete: ({ findingsJson }) =>
            startedTask.environment.commitAndPushWorkBranch?.({
              result: findingsJson,
            }) ?? Promise.resolve(undefined),
        }),
      );

      expect(failure.message).toContain("Failed to push work branch");
      expect(completeTaskRun).not.toHaveBeenCalled();
    },
  );
});

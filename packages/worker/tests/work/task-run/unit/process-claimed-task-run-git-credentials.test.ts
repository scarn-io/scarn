/**
 * `startProcessClaimedTaskRun` hands the runtime launch the claim token and an
 * `onSecretValues` sink that reaches the log masker, so a git credential the
 * relay issues mid-run never surfaces in the shipped feed.
 */
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "bun:test";
import { startProcessClaimedTaskRun } from "../../../../src/work/task-run/application/process-claimed-task-run";
import {
  createRecordingOrchestrator,
  createRoutingDeps,
  createRunTracker,
  createWorkerClient,
  projectId,
  requestedByUserId,
  taskRunId,
} from "./helpers/claimed-task-fixtures";

describe("startProcessClaimedTaskRun git credential secrets", () => {
  test("passes the claim token and routes onSecretValues to the masker", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "scarn-claimed-step-git-cred-"),
    );
    const { launch } = createRecordingOrchestrator(workspacePath);
    const logStream = {
      registerSecretValues: vi.fn(),
      attachOpencodeTail: vi.fn(),
      attachConversationStream: vi.fn(),
      shipDevcontainerLogLine: vi.fn(),
    };
    const deps = createRoutingDeps({
      workerClient: createWorkerClient(),
      workspaceOrchestrator: { launch },
    });

    await startProcessClaimedTaskRun(
      {
        projectId,
        requestedByUserId,
        claim: { task: { id: taskRunId }, claimToken: "claim-token" },
        leaseDurationSeconds: 30,
      },
      deps,
      deps.workerClient,
      createRunTracker(),
      logStream,
    );

    const launchInput = (
      launch.mock.calls as unknown as [
        {
          claimToken: string;
          onSecretValues?: (values: readonly string[]) => void;
        },
      ][]
    )[0]?.[0];
    expect(launchInput?.claimToken).toBe("claim-token");
    launchInput?.onSecretValues?.(["relay-issued-password"]);
    expect(logStream.registerSecretValues).toHaveBeenCalledWith([
      "relay-issued-password",
    ]);
  });
});

import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "bun:test";
import type { Grant } from "@scarn/sdk";
import {
  createRecordingOrchestrator,
  createRoutingDeps,
  createWorkerClient,
  createWorkerContext,
  runClaim,
} from "./helpers/claimed-task-fixtures";

describe("startProcessClaimedTaskRun grants", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("hands the Task's grants to the launch's current execution info", async () => {
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "scarn-claimed-step-grants-"),
    );
    const { launch } = createRecordingOrchestrator(workspacePath, {
      resolvedBranch: "main",
      devcontainerConfigPath: ".devcontainer/devcontainer.json",
      runtimeContainerId: "runtime-container-id",
      aiImage: "scarn/ai-worker:local",
      networkName: "test-network",
    });
    const grants: Grant[] = [
      { resource: "workItem", action: "read", scope: "self" },
      {
        resource: "workItem",
        action: "create",
        scope: "children",
        labels: ["task"],
      },
    ];
    const workerClient = createWorkerClient();
    workerClient.getTaskRunWorkerContext = vi.fn(() =>
      Promise.resolve(createWorkerContext(undefined, undefined, { grants })),
    );
    const deps = createRoutingDeps({
      workerClient,
      workspaceOrchestrator: { launch },
    });

    await runClaim(deps);

    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        currentExecutionInfo: expect.objectContaining({ grants }) as unknown,
      }),
    );
  });
});

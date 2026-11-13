/**
 * `.scarn/.env` is read once per claim, so a long-running worker launches each
 * run with the file as it is when that run is claimed.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { parseUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { readLocalEnvVars } from "../../../../src/project/local-env/read-local-env-vars";
import { RunRegistry } from "../../../../src/work/task-run/application/run-registry";
import { scheduleClaimedTaskRunJob } from "../../../../src/work/task-run/application/schedule-claimed-task-runs";
import type { TaskRunWorkerClaim } from "../../../../src/work/task-run/contracts/process-project-work-types";
import { captureRejection } from "../../../support/capture-rejection";
import {
  createRoutingDeps,
  createRunTracker,
  createWorkerClient,
  projectId,
} from "./helpers/claimed-task-fixtures";

function claimFor(id: string): TaskRunWorkerClaim {
  return { task: { id: parseUuidV7(id) }, claimToken: `claim-${id}` };
}

describe("scheduleClaimedTaskRunJob .scarn/.env", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(path.join(os.tmpdir(), "scarn-local-env-"));
    await mkdir(path.join(repoDir, ".scarn"));
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  test("a rewritten .env is picked up on the next claim", async () => {
    const launched: unknown[] = [];
    const launch = vi.fn((input: { localEnvVars?: unknown }) => {
      launched.push(input.localEnvVars);
      return Promise.reject(new Error("launch stopped by test"));
    });
    const deps = createRoutingDeps({
      workerClient: createWorkerClient(),
      workspaceOrchestrator: { launch },
    });
    const readLocalEnv = vi.fn(() => readLocalEnvVars(repoDir));
    const runs = new RunRegistry();
    const schedule = (claim: TaskRunWorkerClaim) =>
      scheduleClaimedTaskRunJob(
        {
          projectId,
          batchSize: 1,
          concurrency: 1,
          pollIntervalMs: 0,
          leaseDurationSeconds: 30,
          workerId: "worker-1",
          once: true,
          readLocalEnv,
        },
        deps,
        claim,
        createRunTracker(),
        { claimedCount: 1, processedCount: 0, skippedCount: 0 },
        runs,
      );

    const envFile = path.join(repoDir, ".scarn", ".env");
    await writeFile(envFile, "API_TOKEN=first\n");
    await captureRejection(
      schedule(claimFor("01966a2c-9494-7db5-aa46-0f8f5cbbe011")),
    );

    await writeFile(envFile, "API_TOKEN=second\nEXTRA=1\n");
    await captureRejection(
      schedule(claimFor("01966a2c-9494-7db5-aa46-0f8f5cbbe012")),
    );

    expect(readLocalEnv).toHaveBeenCalledTimes(2);
    expect(launched).toEqual([
      { API_TOKEN: "first" },
      { API_TOKEN: "second", EXTRA: "1" },
    ]);
  });
});

/**
 * A claimed run resolves its `secret` vars before the runtime starts: from
 * `.scarn/.env` first, else with one call to Scarn. Scarn-delivered values are
 * registered with the log masker, and a failed call fails the run naming the
 * secrets, never their values.
 */
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "bun:test";
import type { EnvVarSpec } from "@scarn/sdk/env-vars";
import { startProcessClaimedTaskRun } from "../../../../src/work/task-run/application/process-claimed-task-run";
import { buildTaskRunFailurePayload } from "../../../../src/work/task-run/application/build-task-run-failure-payload";
import { SecretMasker } from "../../../../src/work/task-run/application/secret-masker";
import type { TaskRunWorkerClient } from "../../../../src/work/task-run/contracts/process-project-work-types";
import {
  createRecordingOrchestrator,
  createRoutingDeps,
  createRunTracker,
  createWorkerClient,
  projectId,
  requestedByUserId,
  taskRunId,
} from "./helpers/claimed-task-fixtures";

const SCARN_VALUE = "scarn-delivered-secret-value";

const envJson: EnvVarSpec[] = [
  {
    name: "DD_API_KEY",
    source: "secret",
    secretName: "DD_KEY",
    applies: "agent",
  },
  {
    name: "SETUP_TOKEN",
    source: "secret",
    secretName: "LOCAL_KEY",
    applies: "setup",
  },
];

async function runWithSecrets(
  resolveTaskRunEnvironment: TaskRunWorkerClient["resolveTaskRunEnvironment"],
  localEnvVars: Record<string, string> = { LOCAL_KEY: "local-secret-value" },
) {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "scarn-claimed-project-secrets-"),
  );
  const { launch } = createRecordingOrchestrator(workspacePath);
  const masker = new SecretMasker();
  const logStream = {
    registerSecretValues: vi.fn((values: readonly string[]) => {
      masker.register(values);
    }),
    attachOpencodeTail: vi.fn(),
    attachConversationStream: vi.fn(),
    shipDevcontainerLogLine: vi.fn(),
  };
  const workerClient = {
    ...createWorkerClient({ kind: "inline", envJson }),
    resolveTaskRunEnvironment,
  };
  const deps = createRoutingDeps({
    workerClient,
    workspaceOrchestrator: { launch },
  });
  const run = startProcessClaimedTaskRun(
    {
      projectId,
      requestedByUserId,
      claim: { task: { id: taskRunId }, claimToken: "claim-token" },
      leaseDurationSeconds: 30,
      localEnvVars,
    },
    deps,
    workerClient,
    createRunTracker(),
    logStream,
  );
  return { run, launch, masker };
}

describe("startProcessClaimedTaskRun project secrets", () => {
  test("requests only names .scarn/.env lacks and masks the Scarn value", async () => {
    const resolveTaskRunEnvironment = vi.fn(() =>
      Promise.resolve({
        secrets: { DD_KEY: { value: SCARN_VALUE, expiresAt: null } },
        missing: [],
      }),
    );
    const { run, launch, masker } = await runWithSecrets(
      resolveTaskRunEnvironment,
    );
    await run;

    expect(resolveTaskRunEnvironment).toHaveBeenCalledTimes(1);
    expect(resolveTaskRunEnvironment).toHaveBeenCalledWith({
      taskRunId,
      claimToken: "claim-token",
      secretNames: ["DD_KEY"],
    });
    const launchInput = launch.mock.calls[0]?.[0];
    expect(launchInput?.stepEnv).toEqual({ DD_API_KEY: SCARN_VALUE });
    expect(launchInput?.setupEnv).toEqual({
      SETUP_TOKEN: "local-secret-value",
    });
    expect(masker.mask(`echo ${SCARN_VALUE}`)).toBe("echo ***");
  });

  test("makes no call when .scarn/.env has every name", async () => {
    const resolveTaskRunEnvironment = vi.fn();
    const { run, launch } = await runWithSecrets(resolveTaskRunEnvironment, {
      LOCAL_KEY: "local-secret-value",
      DD_KEY: "worker-dd-value",
    });
    await run;

    expect(resolveTaskRunEnvironment).not.toHaveBeenCalled();
    expect(launch.mock.calls[0]?.[0].stepEnv).toEqual({
      DD_API_KEY: "worker-dd-value",
    });
  });

  test("a failed Scarn call fails the run before launch, naming secrets only", async () => {
    const resolveTaskRunEnvironment = vi.fn(() =>
      Promise.reject(
        new Error(
          JSON.stringify({ code: "TASK_OWNERSHIP_CONFLICT", status: 409 }),
        ),
      ),
    );
    const { run } = await runWithSecrets(resolveTaskRunEnvironment);
    let error: unknown;
    try {
      await run;
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const payload = buildTaskRunFailurePayload(error as Error);
    expect(payload.errorJson.code).toBe("SCARN_ENVIRONMENT_UNRESOLVED");
    expect(payload.errorJson.message).toContain("DD_KEY");
    expect(payload.errorJson.message).toContain("TASK_OWNERSHIP_CONFLICT");
    expect(JSON.stringify(payload)).not.toContain("local-secret-value");
  });

  test("a secret Scarn reports missing fails with the combined message", async () => {
    const resolveTaskRunEnvironment = vi.fn(() =>
      Promise.resolve({ secrets: {}, missing: ["DD_KEY"] }),
    );
    const { run } = await runWithSecrets(resolveTaskRunEnvironment);
    let error: unknown;
    try {
      await run;
    } catch (caught) {
      error = caught;
    }

    const payload = buildTaskRunFailurePayload(error as Error);
    expect(payload.errorJson.code).toBe("SCARN_ENVIRONMENT_UNRESOLVED");
    expect(payload.errorJson.message).toContain(
      "DD_KEY (project secret for DD_API_KEY)",
    );
    expect(payload.errorJson.message).toContain(
      "set it in .scarn/.env or save it as a project secret",
    );
  });
});

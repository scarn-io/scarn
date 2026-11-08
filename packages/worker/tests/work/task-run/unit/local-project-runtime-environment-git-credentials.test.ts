/**
 * The git credential relay through the single-container launch orchestrator:
 * a `gitCredentials: "auto"` step opens the session before
 * `devcontainerLauncher.launch` and stops it on cleanup and on a failed
 * launch; a `none` step never opens one. Shares the launch fakes in
 * `helpers/orchestrator-launch-fakes.ts`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RepoConfig } from "@scarn/sdk/repo-config";
import { DefaultLocalProjectRuntimeEnvironmentOrchestrator } from "../../../../src/work/task-run/infra/local-project-runtime-environment";
import {
  buildLaunchInput,
  buildOrchestratorFakeDeps,
  rejectionOf,
  type CallLog,
} from "./helpers/orchestrator-launch-fakes";

const AUTO_REPO: RepoConfig = {
  mode: "readWrite",
  message: null,
  onPushFailure: "fail",
  gitCredentials: "auto",
};

describe("launch with gitCredentials", () => {
  let sessionDir: string;
  let providerOutputDir: string;

  beforeEach(async () => {
    sessionDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-ws-"));
    providerOutputDir = await mkdtemp(
      path.join(os.tmpdir(), "orchestrator-provider-"),
    );
  });

  afterEach(async () => {
    await rm(sessionDir, { recursive: true, force: true });
    await rm(providerOutputDir, { recursive: true, force: true });
  });

  function setup() {
    const log: CallLog = [];
    const deps = buildOrchestratorFakeDeps({
      workspacePath: path.join(sessionDir, "repo"),
      providerOutputDir,
      log,
    });
    const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      {},
      deps,
    );
    return { log, deps, orchestrator };
  }

  test("opens the session before the devcontainer launch and stops it on cleanup", async () => {
    const { log, deps, orchestrator } = setup();
    const secrets: string[] = [];
    const input = buildLaunchInput();

    const environment = await orchestrator.launch({
      ...input,
      repo: AUTO_REPO,
      onSecretValues: (values) => {
        secrets.push(...values);
      },
    });

    expect(log.indexOf("openGitCredentialRelay")).toBeGreaterThan(-1);
    expect(log.indexOf("openGitCredentialRelay")).toBeLessThan(
      log.indexOf("launchDevcontainer"),
    );
    const opened = deps.gitCredentialRelay.openInputs[0];
    expect(opened?.sessionId).toBe(input.sessionId);
    expect(opened?.runContext).toEqual({
      taskRunId: input.currentExecutionInfo.taskRunId,
      claimToken: input.claimToken,
      repoGitUrl: input.gitUrl,
    });
    opened?.onSecretValues(["relay-password"]);
    expect(secrets).toEqual(["relay-password"]);
    expect(deps.gitCredentialRelay.stopCalls).toBe(0);

    await environment.cleanup();

    expect(deps.gitCredentialRelay.stopCalls).toBe(1);
  });

  test("stops the session when the launch fails after it opened", async () => {
    const { deps, orchestrator } = setup();
    deps.devcontainerLauncher.launch = () =>
      Promise.reject(new Error("devcontainer up failed"));

    expect(
      await rejectionOf(
        orchestrator.launch({ ...buildLaunchInput(), repo: AUTO_REPO }),
      ),
    ).toMatchObject({
      message: "devcontainer up failed",
    });

    expect(deps.gitCredentialRelay.openInputs).toHaveLength(1);
    expect(deps.gitCredentialRelay.stopCalls).toBe(1);
  });

  test("stops the session on a failed launch that preserves the runtime", async () => {
    const { deps, orchestrator } = setup();
    deps.devcontainerLauncher.launch = () =>
      Promise.reject(new Error("devcontainer up failed"));

    expect(
      await rejectionOf(
        orchestrator.launch({
          ...buildLaunchInput(),
          repo: AUTO_REPO,
          preserveRuntimeOnFailure: true,
        }),
      ),
    ).toMatchObject({
      message: "devcontainer up failed",
    });

    expect(deps.gitCredentialRelay.stopCalls).toBe(1);
  });

  test("never opens a session when the step opts out", async () => {
    const { log, deps, orchestrator } = setup();

    const environment = await orchestrator.launch({
      ...buildLaunchInput(),
      repo: { ...AUTO_REPO, gitCredentials: "none" },
    });
    await environment.cleanup();

    expect(deps.gitCredentialRelay.openInputs).toHaveLength(0);
    expect(log).not.toContain("openGitCredentialRelay");
  });
});

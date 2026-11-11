/**
 * A chat run through the single-container launch orchestrator: the clone is
 * parked detached on the pinned commit (pinning it first on the first run)
 * before the devcontainer starts, with no work branch, no push and no git
 * credentials. Shares the launch fakes in `helpers/orchestrator-launch-fakes.ts`.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type { RepoConfig } from "@scarn/sdk/repo-config";
import { buildTaskRunFailurePayload } from "../../../../src/work/task-run/application/build-task-run-failure-payload";
import { DefaultLocalProjectRuntimeEnvironmentOrchestrator } from "../../../../src/work/task-run/infra/local-project-runtime-environment";
import {
  buildLaunchInput,
  buildOrchestratorFakeDeps,
  FakeGitCommitPushService,
  FakeRepoContextGit,
  rejectionOf,
  type CallLog,
} from "./helpers/orchestrator-launch-fakes";

const CHAT_REPO: RepoConfig = {
  mode: "readOnly",
  gitCredentials: "none",
};
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

describe("launch with a repo context (chat run)", () => {
  let workspacePath: string;
  let providerOutputDir: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), "orchestrator-ws-"));
    providerOutputDir = await mkdtemp(
      path.join(os.tmpdir(), "orchestrator-provider-"),
    );
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
    await rm(providerOutputDir, { recursive: true, force: true });
  });

  function setup(localEnvVars: Record<string, string> = {}) {
    const log: CallLog = [];
    const commitPush = new FakeGitCommitPushService(log);
    const repoContextGit = new FakeRepoContextGit(log);
    const deps = buildOrchestratorFakeDeps({
      workspacePath,
      providerOutputDir,
      log,
      gitCommitPushService: commitPush,
      repoContextGit,
    });
    const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      localEnvVars,
      deps,
    );
    return { log, deps, commitPush, repoContextGit, orchestrator };
  }

  async function writeProjectConfig(config: Record<string, unknown>) {
    await mkdir(path.join(workspacePath, ".scarn"), { recursive: true });
    await writeFile(
      path.join(workspacePath, ".scarn", "scarn.jsonc"),
      JSON.stringify({ project: "acme/web-app", ...config }),
      "utf8",
    );
  }

  test("first run: pins the configured baseWorkBranch, ignoring the source branch and env override, and checks out the stored commit", async () => {
    await writeProjectConfig({ baseWorkBranch: "develop" });
    const { log, commitPush, repoContextGit, orchestrator } = setup({
      SCARN_BASE_WORK_BRANCH: "env-branch",
    });
    repoContextGit.branchCommits.set("develop", COMMIT_A);
    const pinBaseCommit = vi.fn(() => Promise.resolve(COMMIT_B));

    const env = await orchestrator.launch({
      ...buildLaunchInput(),
      repo: CHAT_REPO,
      stepKey: "chat",
      sourceBranch: "worker-local-branch",
      baseWorkBranch: "ignored-base",
      repoContext: { baseCommit: null, pinBaseCommit },
    });

    expect(repoContextGit.resolveCalls).toEqual(["develop"]);
    expect(pinBaseCommit).toHaveBeenCalledWith({
      baseCommit: COMMIT_A,
      baseBranch: "develop",
    });
    expect(repoContextGit.checkoutCalls).toEqual([COMMIT_B]);
    expect(commitPush.checkoutBaseCalls).toEqual([]);
    expect(commitPush.createBranchCalls).toEqual([]);
    expect(env.workBranch).toBeNull();
    expect(env.createdFromBranch).toBeNull();
    expect(env.commitAndPushWorkBranch).toBeUndefined();
    expect(log.indexOf("checkoutCommit")).toBeGreaterThan(log.indexOf("clone"));
    expect(log.indexOf("checkoutCommit")).toBeLessThan(
      log.indexOf("launchDevcontainer"),
    );
  });

  test("first run without a configured base: pins the cloned default branch", async () => {
    const { repoContextGit, orchestrator } = setup();
    repoContextGit.branchCommits.set("main", COMMIT_A);
    const pinBaseCommit = vi.fn(() => Promise.resolve(COMMIT_A));

    await orchestrator.launch({
      ...buildLaunchInput(),
      repo: CHAT_REPO,
      repoContext: { baseCommit: null, pinBaseCommit },
    });

    expect(repoContextGit.resolveCalls).toEqual(["main"]);
    expect(pinBaseCommit).toHaveBeenCalledWith({
      baseCommit: COMMIT_A,
      baseBranch: "main",
    });
    expect(repoContextGit.checkoutCalls).toEqual([COMMIT_A]);
  });

  test("later run: checks out the pinned commit without resolving or reporting", async () => {
    await writeProjectConfig({ baseWorkBranch: "develop" });
    const { repoContextGit, orchestrator } = setup();
    repoContextGit.branchCommits.set("develop", COMMIT_B);
    const pinBaseCommit = vi.fn(() => Promise.resolve(COMMIT_B));

    await orchestrator.launch({
      ...buildLaunchInput(),
      repo: CHAT_REPO,
      repoContext: { baseCommit: COMMIT_A, pinBaseCommit },
    });

    expect(repoContextGit.resolveCalls).toEqual([]);
    expect(pinBaseCommit).not.toHaveBeenCalled();
    expect(repoContextGit.checkoutCalls).toEqual([COMMIT_A]);
  });

  test("a missing pinned commit fails with REPO_CONTEXT_COMMIT_UNAVAILABLE before the container starts", async () => {
    const { log, repoContextGit, orchestrator } = setup();
    repoContextGit.missingCommits.add(COMMIT_A);
    const pinBaseCommit = vi.fn(() => Promise.resolve(COMMIT_B));

    const error = await rejectionOf(
      orchestrator.launch({
        ...buildLaunchInput(),
        repo: CHAT_REPO,
        repoContext: { baseCommit: COMMIT_A, pinBaseCommit },
      }),
    );

    expect(pinBaseCommit).not.toHaveBeenCalled();
    expect(log).not.toContain("launchDevcontainer");
    expect(buildTaskRunFailurePayload(error as Error).errorJson.code).toBe(
      "REPO_CONTEXT_COMMIT_UNAVAILABLE",
    );
  });

  test("opens no git credential relay", async () => {
    const { log, deps, repoContextGit, orchestrator } = setup();
    repoContextGit.branchCommits.set("main", COMMIT_A);

    await orchestrator.launch({
      ...buildLaunchInput(),
      repo: CHAT_REPO,
      repoContext: {
        baseCommit: null,
        pinBaseCommit: (pin) => Promise.resolve(pin.baseCommit),
      },
    });

    expect(log).not.toContain("openGitCredentialRelay");
    expect(deps.gitCredentialRelay.openInputs).toEqual([]);
  });
});

/**
 * `WorkBranch.base()` against REAL temp git repos: `prepareWorkBranch` checks
 * the base out as a local tracking branch, the commit closure commits onto it
 * and pushes without force, a commit pushed to origin meanwhile fails the push
 * per `onPushFailure`, and a base the step didn't name explicitly is refused.
 */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import type { RepoOnPushFailure } from "@scarn/sdk/repo-config";
import { GitCliCommitPushService } from "../../../../src/runtime/runtime-service/infra/git-cli-commit-push-service";
import { RepoBranchInvalidError } from "../../../../src/work/task-run/application/repo-branch-invalid-error";
import type { BaseBranchSource } from "../../../../src/work/task-run/contracts/environment-diagnostics";
import {
  buildCommitAndPushWorkBranch,
  prepareWorkBranch,
  WorkBranchPushError,
} from "../../../../src/work/task-run/infra/work-branch-manager";
import { captureRejection } from "../../../support/capture-rejection";
import {
  git,
  writeRepoFile,
} from "../../../runtime/runtime-service/unit/git-test-fixtures";
import {
  FakeGitCommitPushService,
  FakeSubmoduleService,
} from "./helpers/orchestrator-launch-fakes";

const TASK_ID = "0192f000-0000-7000-8000-000000000000";
const BASE = "ephemeral-1234";

setDefaultTimeout(15_000);

describe("WorkBranch.base()", () => {
  let root: string;
  let remote: string;
  let seed: string;
  let workspace: string;
  const service = new GitCliCommitPushService();

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "commit-onto-base-"));
    remote = path.join(root, "remote.git");
    seed = path.join(root, "seed");
    workspace = path.join(root, "workspace");
    await mkdir(remote, { recursive: true });
    await git(remote, ["init", "--bare", "-b", "main"]);
    await git(root, ["clone", remote, seed]);
    await git(seed, ["config", "user.email", "seed@scarn.io"]);
    await git(seed, ["config", "user.name", "Seed"]);
    await commitFile(seed, "README.md", "init");
    await git(seed, ["push", "origin", "main"]);
    await git(seed, ["checkout", "-b", BASE]);
    await commitFile(seed, "base.txt", "base");
    await git(seed, ["push", "origin", BASE]);
    await git(root, ["clone", remote, workspace]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function commitFile(repo: string, file: string, message: string) {
    await writeRepoFile(repo, file, `${message}\n`);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "--no-gpg-sign", "-m", message]);
  }

  function prepare(
    baseSource: BaseBranchSource,
    baseWorkBranch: string | null,
  ) {
    return prepareWorkBranch({
      gitCommitPushService: service,
      workspacePath: workspace,
      resolvedBranch: "main",
      baseWorkBranch,
      stepKey: "impl",
      taskRunId: TASK_ID,
      workBranch: { kind: "base" },
      baseSource,
    });
  }

  function commitAndPush(onPushFailure: RepoOnPushFailure = "fail") {
    return buildCommitAndPushWorkBranch({
      gitCommitPushService: service,
      submoduleService: new FakeSubmoduleService(),
      workspacePath: workspace,
      workBranch: BASE,
      submoduleWorkBranch: `scarn/impl-${TASK_ID}`,
      taskRunId: TASK_ID,
      onPushFailure,
    })({ result: {} });
  }

  test("commits onto the base and pushes it", async () => {
    const prepared = await prepare("step", BASE);
    expect(prepared).toEqual({
      workBranch: BASE,
      createdFromBranch: BASE,
      submoduleWorkBranch: `scarn/impl-${TASK_ID}`,
    });
    expect(await git(workspace, ["branch", "--show-current"])).toBe(BASE);
    expect(
      await git(workspace, ["rev-parse", "--abbrev-ref", `${BASE}@{upstream}`]),
    ).toBe(`origin/${BASE}`);

    await writeRepoFile(workspace, "work.txt", "agent work\n");
    expect(await commitAndPush()).toEqual({ pushed: true });

    expect(await git(remote, ["rev-parse", BASE])).toBe(
      await git(workspace, ["rev-parse", "HEAD"]),
    );
    expect(await git(remote, ["show", `${BASE}:work.txt`])).toBe("agent work");
    expect(await git(remote, ["branch", "--list", "scarn/*"])).toBe("");
  });

  test("a commit pushed to origin meanwhile fails the push, not forced", async () => {
    await prepare("server", BASE);
    await commitFile(seed, "other.txt", "someone else");
    await git(seed, ["push", "origin", BASE]);
    const otherTip = await git(seed, ["rev-parse", "HEAD"]);

    await writeRepoFile(workspace, "work.txt", "agent work\n");
    const failure = await captureRejection(commitAndPush());

    expect(failure).toBeInstanceOf(WorkBranchPushError);
    expect((failure as WorkBranchPushError).originMoved).toBe(true);
    expect(failure.message).toContain("origin moved; not forced");
    expect(failure.message).toContain(BASE);
    expect(await git(remote, ["rev-parse", BASE])).toBe(otherTip);
  });

  test('origin moving under "warn" leaves the branch unpushed', async () => {
    await prepare("step", BASE);
    await commitFile(seed, "other.txt", "someone else");
    await git(seed, ["push", "origin", BASE]);
    const otherTip = await git(seed, ["rev-parse", "HEAD"]);

    await writeRepoFile(workspace, "work.txt", "agent work\n");
    expect(await commitAndPush("warn")).toEqual({ pushed: false });
    expect(await git(remote, ["rev-parse", BASE])).toBe(otherTip);
  });

  for (const [source, base] of [
    ["remoteDefault", null],
    ["worker", BASE],
    ["project", BASE],
  ] as const) {
    test(`a base from the ${source} rule fails with RepoBranchInvalid before checkout`, async () => {
      const commitPush = new FakeGitCommitPushService();
      const failure = await captureRejection(
        prepareWorkBranch({
          gitCommitPushService: commitPush,
          workspacePath: workspace,
          resolvedBranch: "main",
          baseWorkBranch: base,
          stepKey: "impl",
          taskRunId: TASK_ID,
          workBranch: { kind: "base" },
          baseSource: source,
        }),
      );

      expect(failure).toBeInstanceOf(RepoBranchInvalidError);
      expect(failure.message).toContain("explicit baseBranch");
      expect(commitPush.checkoutBaseCalls).toEqual([]);
      expect(commitPush.createBranchCalls).toEqual([]);
    });
  }
});

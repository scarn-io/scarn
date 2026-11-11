/**
 * {@link GitCliRepoContext} against real temp repos: a bare remote, a seed
 * clone that publishes commits, and a fresh workspace clone per test.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { RepoContextCommitUnavailableError } from "../../../../src/work/task-run/application/repo-context-commit-unavailable-error";
import { GitCliRepoContext } from "../../../../src/work/task-run/infra/git-cli-repo-context";
import {
  git,
  writeRepoFile,
} from "../../../runtime/runtime-service/unit/git-test-fixtures";
import { rejectionOf } from "./helpers/orchestrator-launch-fakes";

setDefaultTimeout(15_000);

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function setupFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "git-repo-context-"));
  roots.push(root);
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  const workspace = path.join(root, "workspace");
  await mkdir(remote, { recursive: true });
  await git(remote, ["init", "--bare", "-b", "main"]);
  await git(root, ["clone", remote, seed]);
  await git(seed, ["config", "user.email", "seed@scarn.io"]);
  await git(seed, ["config", "user.name", "Seed"]);

  async function commitOn(branch: string, label: string): Promise<string> {
    await git(seed, ["checkout", "-B", branch]);
    await writeRepoFile(seed, `${label}.txt`, `${label}\n`);
    await git(seed, ["add", "-A"]);
    await git(seed, ["commit", "--no-gpg-sign", "-m", label]);
    await git(seed, ["push", "--force", "origin", branch]);
    return git(seed, ["rev-parse", "HEAD"]);
  }

  async function cloneWorkspace(): Promise<void> {
    await git(root, ["clone", "--no-tags", remote, workspace]);
  }

  return { root, remote, seed, workspace, commitOn, cloneWorkspace };
}

describe("GitCliRepoContext", () => {
  const repoContext = new GitCliRepoContext();

  test("resolves a remote branch to its full commit", async () => {
    const fx = await setupFixture();
    await fx.commitOn("main", "one");
    const developCommit = await fx.commitOn("develop", "two");
    await fx.cloneWorkspace();

    const resolved = await repoContext.resolveRemoteBranchCommit({
      workspacePath: fx.workspace,
      branch: "develop",
    });

    expect(resolved).toBe(developCommit);
    expect(resolved).toMatch(/^[0-9a-f]{40}$/u);
  });

  test("checks out the pinned commit detached after the branch moved", async () => {
    const fx = await setupFixture();
    const commitA = await fx.commitOn("main", "a");
    await fx.commitOn("main", "b");
    await fx.cloneWorkspace();

    await repoContext.checkoutCommit({
      workspacePath: fx.workspace,
      commit: commitA,
    });

    expect(await git(fx.workspace, ["rev-parse", "HEAD"])).toBe(commitA);
    expect(await git(fx.workspace, ["branch", "--show-current"])).toBe("");
  });

  test("fetches a pinned commit the clone does not have", async () => {
    const fx = await setupFixture();
    await fx.commitOn("main", "base");
    await fx.cloneWorkspace();
    const later = await fx.commitOn("feature", "later");

    await repoContext.checkoutCommit({
      workspacePath: fx.workspace,
      commit: later,
    });

    expect(await git(fx.workspace, ["rev-parse", "HEAD"])).toBe(later);
  });

  test("a commit gone from the remote fails as unavailable", async () => {
    const fx = await setupFixture();
    await fx.commitOn("main", "base");
    await fx.cloneWorkspace();
    const missing = "0123456789abcdef0123456789abcdef01234567";

    const error = await rejectionOf(
      repoContext.checkoutCommit({
        workspacePath: fx.workspace,
        commit: missing,
      }),
    );

    expect(error).toBeInstanceOf(RepoContextCommitUnavailableError);
    expect((error as Error).message).toContain(missing);
  });
});

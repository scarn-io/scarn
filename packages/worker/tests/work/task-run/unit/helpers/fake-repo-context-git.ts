import type { RepoContextGit } from "../../../../../src/work/task-run/infra/git-cli-repo-context";
import { RepoContextCommitUnavailableError } from "../../../../../src/work/task-run/application/repo-context-commit-unavailable-error";

/**
 * Recording repo-context git fake. `branchCommits` maps a branch to the commit
 * it resolves to; `missingCommits` makes `checkoutCommit` throw the
 * unavailable error.
 */
export class FakeRepoContextGit implements RepoContextGit {
  readonly resolveCalls: string[] = [];
  readonly checkoutCalls: string[] = [];
  readonly branchCommits = new Map<string, string>();
  readonly missingCommits = new Set<string>();

  constructor(private readonly log: string[] = []) {}

  resolveRemoteBranchCommit(input: {
    workspacePath: string;
    branch: string;
  }): Promise<string> {
    this.log.push("resolveRemoteBranchCommit");
    this.resolveCalls.push(input.branch);
    const commit = this.branchCommits.get(input.branch);
    if (!commit) {
      return Promise.reject(new Error(`no branch ${input.branch}`));
    }
    return Promise.resolve(commit);
  }

  checkoutCommit(input: {
    workspacePath: string;
    commit: string;
  }): Promise<void> {
    this.log.push("checkoutCommit");
    this.checkoutCalls.push(input.commit);
    if (this.missingCommits.has(input.commit)) {
      return Promise.reject(
        new RepoContextCommitUnavailableError(input.commit, "not found"),
      );
    }
    return Promise.resolve();
  }
}

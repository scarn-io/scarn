import {
  runGit,
  type GitRunner,
} from "../../../runtime/runtime-service/infra/run-git";
import { RepoContextCommitUnavailableError } from "../application/repo-context-commit-unavailable-error";

/**
 * Git operations for a chat run's repo context: a read-only workspace parked
 * on one exact commit. Kept apart from the branch helpers of
 * `GitCommitPushService`, which manage work branches.
 */
export type RepoContextGit = {
  /**
   * Fetches `refs/heads/<branch>` from `origin` and returns the full commit
   * it points at.
   */
  resolveRemoteBranchCommit(input: {
    workspacePath: string;
    branch: string;
  }): Promise<string>;
  /**
   * Fetches `commit` when the clone lacks it, checks it out detached, and
   * verifies `HEAD`. Throws {@link RepoContextCommitUnavailableError} on
   * failure.
   */
  checkoutCommit(input: {
    workspacePath: string;
    commit: string;
  }): Promise<void>;
};

const FETCH_TIMEOUT_MS = 5 * 60_000;
const LOCAL_TIMEOUT_MS = 60_000;

// eslint-disable-next-line local/no-unknown-parameter-type -- narrows a caught value, not a real input boundary
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** {@link RepoContextGit} over the `git` CLI. */
export class GitCliRepoContext implements RepoContextGit {
  constructor(private readonly git: GitRunner = runGit) {}

  async resolveRemoteBranchCommit(input: {
    workspacePath: string;
    branch: string;
  }): Promise<string> {
    const remoteRef = `refs/remotes/origin/${input.branch}`;
    await this.git(
      [
        "-C",
        input.workspacePath,
        "fetch",
        "--no-tags",
        "origin",
        `+refs/heads/${input.branch}:${remoteRef}`,
      ],
      { label: `fetch ${input.branch}`, timeoutMs: FETCH_TIMEOUT_MS },
    );
    const commit = await this.git(
      [
        "-C",
        input.workspacePath,
        "rev-parse",
        "--verify",
        `${remoteRef}^{commit}`,
      ],
      { label: `rev-parse ${remoteRef}`, timeoutMs: LOCAL_TIMEOUT_MS },
    );
    return commit.trim();
  }

  async checkoutCommit(input: {
    workspacePath: string;
    commit: string;
  }): Promise<void> {
    const { workspacePath, commit } = input;
    try {
      if (!(await this.hasCommit(workspacePath, commit))) {
        await this.git(
          ["-C", workspacePath, "fetch", "--no-tags", "origin", commit],
          { label: `fetch ${commit}`, timeoutMs: FETCH_TIMEOUT_MS },
        );
      }
      await this.git(["-C", workspacePath, "checkout", "--detach", commit], {
        label: `checkout --detach ${commit}`,
        timeoutMs: LOCAL_TIMEOUT_MS,
      });
      const head = (
        await this.git(["-C", workspacePath, "rev-parse", "HEAD"], {
          label: "rev-parse HEAD",
          timeoutMs: LOCAL_TIMEOUT_MS,
        })
      ).trim();
      if (head !== commit) {
        throw new Error(`HEAD is ${head} after checking out ${commit}`);
      }
    } catch (error) {
      if (error instanceof RepoContextCommitUnavailableError) throw error;
      throw new RepoContextCommitUnavailableError(commit, errorMessage(error));
    }
  }

  private async hasCommit(
    workspacePath: string,
    commit: string,
  ): Promise<boolean> {
    try {
      await this.git(
        ["-C", workspacePath, "cat-file", "-e", `${commit}^{commit}`],
        { label: `cat-file ${commit}`, timeoutMs: LOCAL_TIMEOUT_MS },
      );
      return true;
    } catch {
      return false;
    }
  }
}

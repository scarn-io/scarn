/**
 * Error code for a chat run whose pinned commit cannot be checked out (for
 * example, it was force-pushed away). The pin is kept: the run fails instead
 * of silently answering from a different commit.
 */
export const REPO_CONTEXT_COMMIT_UNAVAILABLE_ERROR_CODE =
  "REPO_CONTEXT_COMMIT_UNAVAILABLE";

export const REPO_CONTEXT_COMMIT_UNAVAILABLE_ERROR_NAME =
  "Scarn.RepoContextCommitUnavailable";

export class RepoContextCommitUnavailableError extends Error {
  constructor(
    readonly commit: string,
    reason: string,
  ) {
    super(
      `The commit this conversation is pinned to (${commit}) is no longer available in the repository: ${reason}`,
    );
    this.name = "RepoContextCommitUnavailableError";
  }
}

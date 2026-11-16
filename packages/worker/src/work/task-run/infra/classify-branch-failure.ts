import {
  GitCommandError,
  isEnvironmentFailure,
  isRepoCorruption,
} from "../../../runtime/runtime-service/infra/git-failure";
import { RepoBranchNotFoundError } from "../application/repo-branch-not-found-error";

/** Only Git's explicit missing-remote-ref response establishes branch absence. */
// eslint-disable-next-line local/no-unknown-parameter-type -- narrows a caught failure
export function rethrowBranchFailure(error: unknown, branch: string): never {
  if (
    error instanceof GitCommandError &&
    error.exitCode !== null &&
    !isEnvironmentFailure(error.stderr) &&
    !isRepoCorruption(error.stderr) &&
    error.stderr
      .split("\n")
      .some(
        (line) =>
          line === `fatal: couldn't find remote ref ${branch}` ||
          line === `fatal: couldn't find remote ref refs/heads/${branch}`,
      )
  ) {
    throw new RepoBranchNotFoundError(branch);
  }
  throw error;
}

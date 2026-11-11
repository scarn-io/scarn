import { loadProjectConfig } from "../../../project/project-config/infra/fs-project-config-repo";
import type {
  ProjectWorkLogger,
  RepoContextLaunchInput,
} from "../contracts/process-project-work-types";
import type { RepoContextGit } from "./git-cli-repo-context";

/**
 * Park a fresh clone on a chat run's pinned commit, pinning it first when the
 * run has none yet.
 *
 * The branch to pin is the `baseWorkBranch` of `.scarn/scarn.jsonc` as read
 * from the cloned default branch, else the cloned default branch itself. The
 * worker's source branch and `SCARN_BASE_WORK_BRANCH` are deliberately
 * ignored: a chat is about the project's repo, not this worker's checkout.
 * The server keeps the first reported commit, so the returned value wins over
 * the one resolved here. Returns the checked-out commit.
 */
export async function setUpRepoContext(input: {
  repoContextGit: RepoContextGit;
  workspacePath: string;
  /** The branch the fresh clone checked out: the remote's default branch. */
  resolvedBranch: string;
  repoContext: RepoContextLaunchInput;
  logger?: ProjectWorkLogger | undefined;
}): Promise<string> {
  const commit =
    input.repoContext.baseCommit ??
    (await pinBaseCommit({
      repoContextGit: input.repoContextGit,
      workspacePath: input.workspacePath,
      resolvedBranch: input.resolvedBranch,
      repoContext: input.repoContext,
    }));
  await input.repoContextGit.checkoutCommit({
    workspacePath: input.workspacePath,
    commit,
  });
  input.logger?.log("runtime", `checked out conversation commit ${commit}`);
  return commit;
}

async function pinBaseCommit(input: {
  repoContextGit: RepoContextGit;
  workspacePath: string;
  resolvedBranch: string;
  repoContext: RepoContextLaunchInput;
}): Promise<string> {
  const projectConfig = await loadProjectConfig(input.workspacePath);
  const branch = projectConfig?.baseWorkBranch?.trim() || input.resolvedBranch;
  const resolved = await input.repoContextGit.resolveRemoteBranchCommit({
    workspacePath: input.workspacePath,
    branch,
  });
  return await input.repoContext.pinBaseCommit({
    baseCommit: resolved,
    baseBranch: branch,
  });
}

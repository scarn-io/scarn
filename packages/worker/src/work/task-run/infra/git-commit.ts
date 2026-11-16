import {
  runGit,
  type GitRunner,
} from "../../../runtime/runtime-service/infra/run-git";

export async function readGitCommit(
  workspacePath: string,
  ref: string,
  git: GitRunner = runGit,
): Promise<string> {
  return (
    await git(
      ["-C", workspacePath, "rev-parse", "--verify", `${ref}^{commit}`],
      { label: `resolve commit ${ref}`, timeoutMs: 60_000 },
    )
  ).trim();
}

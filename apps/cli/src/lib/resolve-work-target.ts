/**
 * What a project loop started from a repo checkout works on: the project
 * (positional ref or `"project"` in `.scarn/scarn.jsonc`, resolved against
 * the server), the branch its first step checks out (verified against
 * `origin`), and the repo directory whose `.scarn/.env` it reads.
 */
import { resolveScarnBaseUrl, resolveSourceBranch } from "@scarn/worker";
import { CliError } from "./cli-error";
import {
  NO_PROJECT_MESSAGE,
  pickProjectRef,
  PROJECT_ACTIONS,
  resolveCliProjectRef,
} from "./resolve-project-ref";

export type WorkTarget = {
  baseUrl: string;
  projectRef: string;
  projectId: string;
  repoDir: string;
  sourceBranch: string | null;
  /** Set when the current branch is usable but not in sync with origin. */
  sourceBranchWarning: string | undefined;
};

export type ResolveWorkTargetInput = {
  project?: string | undefined;
  baseUrl?: string | undefined;
  sourceBranch?: string | undefined;
  cwd?: string | undefined;
};

/**
 * Resolves the work target from `cwd` (default `process.cwd()`). Throws a
 * {@link CliError} with `no_project_id` when no project is named, the
 * source-branch error when the branch cannot be used, and the project
 * lookup's error when the ref does not resolve.
 */
export async function resolveWorkTarget(
  input: ResolveWorkTargetInput,
): Promise<WorkTarget> {
  const repoDir = input.cwd ?? process.cwd();
  const baseUrl = resolveScarnBaseUrl(input.baseUrl);
  const projectRef = await pickProjectRef(input.project, repoDir);
  if (!projectRef) throw new CliError("no_project_id", NO_PROJECT_MESSAGE);
  const branch = await resolveSourceBranch({
    cwd: repoDir,
    override: input.sourceBranch,
  });
  const { id: projectId } = await resolveCliProjectRef({
    baseUrl,
    ref: projectRef,
    action: PROJECT_ACTIONS.work,
  });
  return {
    baseUrl,
    projectRef,
    projectId,
    repoDir,
    sourceBranch: branch.branch,
    sourceBranchWarning: branch.warning,
  };
}

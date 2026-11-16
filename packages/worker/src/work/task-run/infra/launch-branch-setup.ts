import type { RepoConfig } from "@scarn/sdk/repo-config";
import { loadProjectConfig } from "../../../project/project-config/infra/fs-project-config-repo";
import type { GitCommitPushService } from "../../../runtime/runtime-service/application/git-commit-push-service";
import { BASE_WORK_BRANCH_ENV_VAR } from "../application/process-claimed-task-run-helpers";
import type {
  BaseBranchSource,
  LaunchBranchDiagnostics,
} from "../contracts/environment-diagnostics";
import type {
  ProjectWorkLogger,
  RepoContextLaunchInput,
} from "../contracts/process-project-work-types";
import type { RepoContextGit } from "./git-cli-repo-context";
import { setUpRepoContext } from "./repo-context-setup";
import { checkoutBaseBranch, prepareWorkBranch } from "./work-branch-manager";

export type LaunchBranchSetup = {
  /** Null when the step creates no work branch. */
  workBranch: string | null;
  /** Null when the step creates no work branch. */
  createdFromBranch: string | null;
  /** The branch submodules commit to; null when the step commits nothing. */
  submoduleWorkBranch: string | null;
  /** The branch the devcontainer config is looked up on. */
  devcontainerLookupBranch: string;
  /** Which branches the run used and why; null for a chat run. */
  branches: LaunchBranchDiagnostics | null;
};

/**
 * The branch a step starts from, first match wins (ADR 0010):
 *
 * - `server`: the server's `baseWorkBranch` (the Task's continued branch, or
 *   the previous step's work branch when the step sets no `baseBranch`)
 * - `step`: the step's rendered `baseBranch`
 * - `worker`: `SCARN_BASE_WORK_BRANCH` in `.scarn/.env`
 * - `project`: `baseWorkBranch` in `.scarn/scarn.jsonc`
 * - `remoteDefault`: the cloned default branch (`branch` null)
 */
export function pickBaseBranch(input: {
  serverBaseWorkBranch: string | null | undefined;
  stepBaseBranch: string | null | undefined;
  localEnvVars: Readonly<Record<string, string>>;
  projectBaseWorkBranch: string | null | undefined;
}): { branch: string | null; source: BaseBranchSource } {
  const candidates: [string | null | undefined, BaseBranchSource][] = [
    [input.serverBaseWorkBranch, "server"],
    [input.stepBaseBranch, "step"],
    [input.localEnvVars[BASE_WORK_BRANCH_ENV_VAR], "worker"],
    [input.projectBaseWorkBranch, "project"],
  ];
  for (const [candidate, source] of candidates) {
    const branch = candidate?.trim();
    if (branch) return { branch, source };
  }
  return { branch: null, source: "remoteDefault" };
}

/**
 * Put a freshly cloned workspace on the right branch for a step.
 *
 * A `readWrite` step with a step key gets a work branch created off its base,
 * or with `WorkBranch.base()` commits onto the base itself. Every other launch (a `readOnly` step, or a dry run, which has no step key)
 * only checks out the base and reports no work branch, so nothing is committed
 * or pushed. The base is picked by {@link pickBaseBranch}.
 *
 * A chat run (`repoContext` set) is instead parked detached on its pinned
 * commit, with no work branch (see `setUpRepoContext`).
 */
export async function setUpLaunchBranches(input: {
  gitCommitPushService: GitCommitPushService;
  workspacePath: string;
  resolvedBranch: string;
  repo: RepoConfig;
  stepKey?: string | undefined;
  taskRunId: string;
  baseWorkBranch?: string | null | undefined;
  /** The step's rendered `baseBranch` (`renderBaseBranch`). */
  stepBaseBranch?: string | null | undefined;
  localEnvVars: Record<string, string>;
  repoContextGit: RepoContextGit;
  repoContext?: RepoContextLaunchInput | undefined;
  logger?: ProjectWorkLogger | undefined;
}): Promise<LaunchBranchSetup> {
  if (input.repoContext) {
    return {
      workBranch: null,
      createdFromBranch: null,
      submoduleWorkBranch: null,
      devcontainerLookupBranch: await setUpRepoContext({
        repoContextGit: input.repoContextGit,
        workspacePath: input.workspacePath,
        resolvedBranch: input.resolvedBranch,
        repoContext: input.repoContext,
        logger: input.logger,
      }),
      branches: null,
    };
  }

  const { stepKey } = input;
  const projectConfig = await loadProjectConfig(input.workspacePath);
  const picked = pickBaseBranch({
    serverBaseWorkBranch: input.baseWorkBranch,
    stepBaseBranch: input.stepBaseBranch,
    localEnvVars: input.localEnvVars,
    projectBaseWorkBranch: projectConfig?.baseWorkBranch,
  });
  const diagnostics = (
    base: string,
    work: string | null,
  ): LaunchBranchDiagnostics => ({
    template: input.repo.baseBranch,
    base,
    source: picked.source,
    work,
    workMode:
      work !== null && input.repo.mode === "readWrite"
        ? input.repo.workBranch.kind
        : null,
  });

  if (stepKey && input.repo.mode === "readWrite") {
    const prepared = await prepareWorkBranch({
      gitCommitPushService: input.gitCommitPushService,
      workspacePath: input.workspacePath,
      resolvedBranch: input.resolvedBranch,
      baseWorkBranch: picked.branch,
      stepKey,
      taskRunId: input.taskRunId,
      branchPrefix: projectConfig?.branchPrefix ?? null,
      workBranch: input.repo.workBranch,
      baseSource: picked.source,
      logger: input.logger,
    });
    return {
      workBranch: prepared.workBranch,
      createdFromBranch: prepared.createdFromBranch,
      submoduleWorkBranch: prepared.submoduleWorkBranch,
      devcontainerLookupBranch: prepared.createdFromBranch,
      branches: diagnostics(prepared.createdFromBranch, prepared.workBranch),
    };
  }

  const base = await checkoutBaseBranch({
    gitCommitPushService: input.gitCommitPushService,
    workspacePath: input.workspacePath,
    resolvedBranch: input.resolvedBranch,
    baseWorkBranch: picked.branch,
  });
  return {
    workBranch: null,
    createdFromBranch: null,
    submoduleWorkBranch: null,
    devcontainerLookupBranch: base,
    branches: diagnostics(base, null),
  };
}

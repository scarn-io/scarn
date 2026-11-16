import {
  describeBaseBranchEnvProblem,
  findBaseBranchEnvProblems,
  repoConfigInputSchema,
  type BaseBranchEnvVar,
  type RepoConfigInput,
  type RepoGitCredentials,
  type RepoWorkBranch,
} from "../../repo-config";
import {
  createPromptInputProxy,
  type PromptInputProxy,
} from "./prompt-template";

/**
 * Authoring helpers for a step's top-level `repo` option, and the
 * definition-time compilation that turns it into the `repo` wire field
 * (`../../repo-config.ts`).
 */

type GitCredentialsOpt = {
  /**
   * Defaults to `"auto"`: git inside the container gets credentials (for
   * private submodules or dependencies) through the worker's per-run
   * credential relay, when the worker has it enabled. The credential may be
   * able to push. `"none"` opts the step out.
   */
  readonly gitCredentials?: RepoGitCredentials;
};

type BranchOpts = {
  /**
   * The branch to start from, a single-line template: `{{input.…}}`,
   * `{{env.NAME}}` (a variable declared in the step's environment) and
   * `{{workItem.platformKey}}` tokens only. Without tokens it must be a valid
   * branch name. When set, it beats the previous step's work branch. Unset,
   * the step starts from the previous step's work branch, else the worker's
   * or project's base branch, else the remote's default branch.
   */
  readonly baseBranch?: string;
};

/** Clones and checks out the base branch; creates no branch, commits and pushes nothing. */
export type ReadOnlyRepoSpec = {
  readonly mode: "readOnly";
} & GitCredentialsOpt &
  BranchOpts;

export type ReadWriteRepoSpec = {
  readonly mode: "readWrite";
  /**
   * Commit message template; `{{input.…}}`, `{{result.…}}`,
   * `{{workItem.title}}` and `{{workItem.platformKey}}` tokens only, one line,
   * at most 500 characters. Defaults to `scarn: task <taskId>`.
   */
  readonly message?: string;
  /** Defaults to `"fail"`: a failed push fails the step. */
  readonly onPushFailure?: "fail" | "warn";
  /**
   * Defaults to `WorkBranch.create()`, a new `scarn/<key>-<id>` branch.
   * `WorkBranch.base()` commits onto the branch the step started from.
   */
  readonly workBranch?: RepoWorkBranch;
} & GitCredentialsOpt &
  BranchOpts;

export type RepoSpec = ReadOnlyRepoSpec | ReadWriteRepoSpec;

/** The work item values a commit message may name, read live at commit time. */
export type CommitMessageWorkItem = { title: string; platformKey: string };

/** The default `env` of a repo function: any variable, as a token. */
export type RepoEnvDefault = PromptInputProxy<
  Record<string, string | undefined>
>;

/**
 * Runs once at definition time, against the same proxies `agentPrompt` and
 * `vars` use. `env` is typed as `agentPrompt`'s is (`PromptEnvContext`).
 */
export type RepoFn<
  TInput,
  TResult,
  TSpec extends RepoSpec,
  TEnv = RepoEnvDefault,
> = (context: {
  input: PromptInputProxy<TInput>;
  result: PromptInputProxy<TResult>;
  /** The Task's work item: `{{workItem.title}}` and `{{workItem.platformKey}}`. */
  workItem: PromptInputProxy<CommitMessageWorkItem>;
  /** The step's environment variables, for `baseBranch`: `{{env.NAME}}`. */
  env: TEnv;
}) => TSpec;

export type RepoField<
  TInput,
  TResult,
  TSpec extends RepoSpec,
  TEnv = RepoEnvDefault,
> = TSpec | RepoFn<TInput, TResult, TSpec, TEnv>;

export type ReadOnlyRepoOpts = Omit<ReadOnlyRepoSpec, "mode">;
export type ReadWriteRepoOpts = Omit<ReadWriteRepoSpec, "mode">;

export const Repo = {
  /**
   * Clones and checks out the base branch, but creates no work branch, commits
   * nothing, pushes nothing and reports no `workBranch`. A policy, not a
   * sandbox: edits the agent makes stay in the workspace and are discarded.
   */
  readOnly(opts?: ReadOnlyRepoOpts): ReadOnlyRepoSpec {
    return { mode: "readOnly", ...opts };
  },

  /**
   * Creates a work branch, then commits and pushes it when the step succeeds.
   * This is the shared default for every runtime.
   */
  readWrite(opts?: ReadWriteRepoOpts): ReadWriteRepoSpec {
    return { mode: "readWrite", ...opts };
  },
} as const;

/** Which branch a `Repo.readWrite()` step commits to (its `workBranch`). */
export const WorkBranch = {
  /** A new `scarn/<key>-<id>` branch. The default. */
  create(): RepoWorkBranch {
    return { kind: "create" };
  },

  /**
   * The branch the step started from: the rendered `baseBranch`, else the
   * previous step's work branch. Pushed without force, so a moved origin fails
   * the push. Needs an explicit `baseBranch`; a worker, project or remote
   * default base is rejected at startup.
   */
  base(): RepoWorkBranch {
    return { kind: "base" };
  },
} as const;

export type CompileRepoContext = {
  /** Named in error messages. */
  readonly stepKey?: string;
};

/**
 * Runs the authored `repo` once (the function form against `input`, `result`,
 * `workItem` and `env` proxies) and returns the wire shape, or `undefined`
 * when the step declares no `repo`. Throws when it breaks the
 * `repoConfigInputSchema` rules, e.g. a `{{result.…}}` token in `baseBranch`.
 */
export function compileRepo<TInput, TResult, TEnv = RepoEnvDefault>(
  repo: RepoField<TInput, TResult, RepoSpec, TEnv> | undefined,
  ctx: CompileRepoContext = {},
): RepoConfigInput | undefined {
  if (repo === undefined) return undefined;

  const spec =
    typeof repo === "function"
      ? repo({
          input: createPromptInputProxy<TInput>(["input"]),
          result: createPromptInputProxy<TResult>(["result"]),
          workItem: createPromptInputProxy<CommitMessageWorkItem>(["workItem"]),
          env: createPromptInputProxy(["env"]) as unknown as TEnv,
        })
      : repo;

  const where = ctx.stepKey ? `Step "${ctx.stepKey}" repo` : "repo";
  const config = toRepoConfigInput(spec);
  const parsed = repoConfigInputSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(
      `${where}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "mode"} ${issue.message}`).join("; ")}`,
    );
  }
  return config;
}

function toRepoConfigInput(spec: RepoSpec): RepoConfigInput {
  switch (spec.mode) {
    case "readWrite":
      return toReadWriteConfig(spec);
    case "readOnly":
      return {
        mode: "readOnly",
        ...gitCredentialsOf(spec),
        ...branchOptsOf(spec),
      };
  }
  throw new Error("repo mode must be readOnly or readWrite");
}

/**
 * Throws when the compiled `repo.baseBranch` has an `{{env.X}}` token the
 * step's environment doesn't allow (undeclared, or secret). `vars` is the
 * environment's var list, or `undefined` for an environment known only by
 * name: the server checks that one at publish.
 */
export function assertBaseBranchFitsEnvironment(
  repo: RepoConfigInput | undefined,
  vars: readonly BaseBranchEnvVar[] | undefined,
  ctx: CompileRepoContext = {},
): void {
  const baseBranch = repo?.baseBranch;
  if (baseBranch == null || vars === undefined) return;
  const problems = findBaseBranchEnvProblems(baseBranch, vars);
  if (problems.length === 0) return;
  const where = ctx.stepKey ? `Step "${ctx.stepKey}" repo` : "repo";
  throw new Error(
    `${where}: baseBranch ${problems.map(describeBaseBranchEnvProblem).join("; ")}`,
  );
}

function gitCredentialsOf(spec: GitCredentialsOpt): GitCredentialsOpt {
  return spec.gitCredentials !== undefined
    ? { gitCredentials: spec.gitCredentials }
    : {};
}

function branchOptsOf(spec: BranchOpts): BranchOpts {
  return spec.baseBranch !== undefined
    ? {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-template-expression -- a bare input or env reference is a proxy object typed as string; the template coerces it to its {{…}} token
        baseBranch: `${spec.baseBranch}`,
      }
    : {};
}

function toReadWriteConfig(spec: ReadWriteRepoSpec): RepoConfigInput {
  return {
    mode: "readWrite",
    ...gitCredentialsOf(spec),
    ...branchOptsOf(spec),
    ...(spec.message !== undefined
      ? {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-template-expression -- a bare input or result reference is a proxy object typed as string; the template coerces it to its {{…}} token
          message: `${spec.message}`,
        }
      : {}),
    ...(spec.onPushFailure !== undefined
      ? { onPushFailure: spec.onPushFailure }
      : {}),
    ...(spec.workBranch !== undefined ? { workBranch: spec.workBranch } : {}),
  };
}

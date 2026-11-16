import { z } from "zod";

/**
 * Wire schema for a step's repository access (`repo`): what the worker does
 * with the clone.
 *
 * - `readOnly`: clones and checks out the base branch, but creates no work
 *   branch, commits nothing and pushes nothing.
 * - `readWrite`: creates a work branch, commits and pushes. `message` is the
 *   commit message template (`{{input.…}}`, `{{result.…}}`,
 *   `{{workItem.title}}` and `{{workItem.platformKey}}` tokens only) and
 *   `onPushFailure` picks whether a failed push fails the step.
 *
 * `readOnly` and `readWrite` also carry `gitCredentials` (`"auto"` or
 * `"none"`): whether git inside the container gets credentials through the
 * worker's credential relay when the worker offers one; `baseBranch`, a branch
 * template (`{{input.…}}`, `{{env.NAME}}` and `{{workItem.platformKey}}`
 * tokens only) the worker renders, which beats the previous step's work
 * branch when set. `readWrite` also carries
 * `workBranch`: a new branch, or the branch the step started from.
 *
 * Two shapes of the same data. `RepoConfigInput` is what an author or API client
 * sends and may leave things out; `RepoConfig` is what is stored, returned and
 * handed to the worker, fully resolved by `resolveRepoConfig`. A resolved
 * `RepoConfig` is also a valid `RepoConfigInput`, so a client can send back what
 * it read (hence a `null` message is accepted on input).
 *
 * Every runtime accepts both repository modes.
 */

export const MAX_REPO_COMMIT_MESSAGE_LENGTH = 500;

export const REPO_COMMIT_MESSAGE_TOKEN_ROOTS: readonly string[] = [
  "input",
  "result",
  "workItem",
];

/**
 * The only `{{workItem.…}}` paths a commit message may use. The worker fills
 * them from a live read of the Task's work item when it commits.
 */
export const REPO_COMMIT_MESSAGE_WORK_ITEM_KEYS: readonly string[] = [
  "title",
  "platformKey",
];

/** Whether `message` has a `{{workItem.…}}` token. */
export function commitMessageUsesWorkItem(message: string): boolean {
  for (const match of message.matchAll(TOKEN_PATTERN)) {
    if ((match[1] ?? "").split(".")[0] === "workItem") return true;
  }
  return false;
}

export type RepoMode = "readOnly" | "readWrite";
export type RepoOnPushFailure = "fail" | "warn";

const TOKEN_PATTERN = /\{\{([^}]+)\}\}/g;

/**
 * Which `{{…}}` tokens a repo template may use. A root in `roots` passes
 * with any path, except that `workItem` takes only `workItemKeys` and a root
 * in `singleSegmentRoots` takes exactly one path segment.
 */
type TemplateTokenRules = {
  readonly roots: readonly string[];
  readonly workItemKeys: readonly string[];
  readonly singleSegmentRoots?: readonly string[];
};

/**
 * Every `{{…}}` token in `template` that `rules` disallow, in order of
 * appearance: its root when that is not one of `rules.roots`, else the whole
 * path. Tokens are parsed the way `renderPromptTemplate` renders them.
 */
function findDisallowedTemplateTokens(
  template: string,
  rules: TemplateTokenRules,
): string[] {
  const disallowed: string[] = [];
  for (const match of template.matchAll(TOKEN_PATTERN)) {
    const path = match[1] ?? "";
    const [root = "", ...rest] = path.split(".");
    if (!rules.roots.includes(root)) {
      disallowed.push(root);
    } else if (
      root === "workItem" &&
      (rest.length !== 1 || !rules.workItemKeys.includes(rest[0] ?? ""))
    ) {
      disallowed.push(path);
    } else if (
      rules.singleSegmentRoots?.includes(root) &&
      (rest.length !== 1 || rest[0] === "")
    ) {
      disallowed.push(path);
    }
  }
  return disallowed;
}

/**
 * Every `{{…}}` token in `message` a commit message may not use, in order of
 * appearance: its root when that is not one of
 * `REPO_COMMIT_MESSAGE_TOKEN_ROOTS`, or the whole path for a `workItem` token
 * other than `REPO_COMMIT_MESSAGE_WORK_ITEM_KEYS`.
 */
export function findDisallowedCommitMessageTokenRoots(
  message: string,
): string[] {
  return findDisallowedTemplateTokens(message, {
    roots: REPO_COMMIT_MESSAGE_TOKEN_ROOTS,
    workItemKeys: REPO_COMMIT_MESSAGE_WORK_ITEM_KEYS,
  });
}

export const MAX_REPO_BASE_BRANCH_LENGTH = 255;

/**
 * The token roots a `baseBranch` template may use. No `result`: there is no
 * result before the step runs. `{{env.X}}` names one variable of the step's
 * environment.
 */
export const REPO_BASE_BRANCH_TOKEN_ROOTS: readonly string[] = [
  "input",
  "env",
  "workItem",
];

/** The only `{{workItem.…}}` path a `baseBranch` may use. */
export const REPO_BASE_BRANCH_WORK_ITEM_KEYS: readonly string[] = [
  "platformKey",
];

/**
 * Every `{{…}}` token in `baseBranch` a base branch template may not use, as
 * `findDisallowedCommitMessageTokenRoots` reports them. An `env` token must
 * name exactly one variable.
 */
export function findDisallowedBaseBranchTokens(baseBranch: string): string[] {
  return findDisallowedTemplateTokens(baseBranch, {
    roots: REPO_BASE_BRANCH_TOKEN_ROOTS,
    workItemKeys: REPO_BASE_BRANCH_WORK_ITEM_KEYS,
    singleSegmentRoots: ["env"],
  });
}

/** Why a `{{env.X}}` token in a `baseBranch` doesn't fit the environment. */
export type BaseBranchEnvProblemReason = "undeclared" | "secret";

export type BaseBranchEnvProblem = {
  /** The whole token path, e.g. `env.TICKET`. */
  token: string;
  reason: BaseBranchEnvProblemReason;
};

/** The parts of an env var the base branch check reads (stored or write shape). */
export type BaseBranchEnvVar =
  | { name: string; source: "value" | "inherit"; secret: boolean }
  | { name: string; source: "secret" };

/**
 * Every `{{env.X}}` token in `baseBranch` that `vars` don't allow, in order
 * of appearance: `X` is not declared, or it is an `Env.secret` or a secret
 * `Env.inherit` (branch names end up in logs, git and the UI).
 */
export function findBaseBranchEnvProblems(
  baseBranch: string,
  vars: readonly BaseBranchEnvVar[],
): BaseBranchEnvProblem[] {
  const problems: BaseBranchEnvProblem[] = [];
  for (const match of baseBranch.matchAll(TOKEN_PATTERN)) {
    const path = (match[1] ?? "").trim();
    const [root, name, ...rest] = path.split(".");
    if (root !== "env" || name === undefined || rest.length > 0) continue;
    const entry = vars.find((candidate) => candidate.name === name);
    if (entry === undefined) {
      problems.push({ token: path, reason: "undeclared" });
    } else if (entry.source === "secret" || entry.secret) {
      problems.push({ token: path, reason: "secret" });
    }
  }
  return problems;
}

/** One line per problem, e.g. `{{env.TOKEN}} names a secret var`. */
export function describeBaseBranchEnvProblem({
  token,
  reason,
}: BaseBranchEnvProblem): string {
  return reason === "secret"
    ? `{{${token}}} names a secret var; branch names end up in logs, git and the UI`
    : `{{${token}}} names a var the environment does not declare`;
}

/**
 * Whether `name` is a valid branch name by `git check-ref-format --branch`'s
 * rules.
 */
export function isValidGitBranchName(name: string): boolean {
  if (name === "" || name === "@") return false;
  if (name.startsWith("-") || name.startsWith("/")) return false;
  if (name.endsWith("/") || name.endsWith(".")) return false;
  if (name.includes("..") || name.includes("//") || name.includes("@{")) {
    return false;
  }
  // eslint-disable-next-line no-control-regex -- git rejects ASCII control characters
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  return name
    .split("/")
    .every(
      (component) => !component.startsWith(".") && !component.endsWith(".lock"),
    );
}

/**
 * Whether `template`'s literal text can be part of a valid branch name: each
 * token is stood in for by a plain segment, so a token-free template must be
 * a valid branch name itself. The rendered name is checked again by the
 * worker.
 */
export function isValidBaseBranchTemplate(template: string): boolean {
  return isValidGitBranchName(template.replace(TOKEN_PATTERN, "x"));
}

export const repoBaseBranchSchema = z
  .string()
  .max(MAX_REPO_BASE_BRANCH_LENGTH)
  .refine((baseBranch) => !/[\r\n]/.test(baseBranch), {
    message: "must be a single line",
  })
  .refine(
    (baseBranch) => findDisallowedBaseBranchTokens(baseBranch).length === 0,
    {
      message:
        "may only use {{input.…}}, {{env.NAME}} and {{workItem.platformKey}} tokens",
    },
  )
  .refine(isValidBaseBranchTemplate, {
    message: "must be a valid branch name (git check-ref-format --branch)",
  });

/**
 * Which branch a `readWrite` step commits to. `create`: a new
 * `scarn/<key>-<id>` branch. `base`: the branch the step started from.
 */
export const repoWorkBranchSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create") }).strict(),
  z.object({ kind: z.literal("base") }).strict(),
]);
export type RepoWorkBranch = z.output<typeof repoWorkBranchSchema>;

export const repoCommitMessageSchema = z
  .string()
  .max(MAX_REPO_COMMIT_MESSAGE_LENGTH)
  .refine((message) => !/[\r\n]/.test(message), {
    message: "must be a single line",
  })
  .refine(
    (message) => findDisallowedCommitMessageTokenRoots(message).length === 0,
    {
      message: `may only use {{input.…}}, {{result.…}}, {{${REPO_COMMIT_MESSAGE_WORK_ITEM_KEYS.map((key) => `workItem.${key}`).join("}} and {{")}}} tokens`,
    },
  );

const onPushFailureSchema = z.enum(["fail", "warn"]);

/**
 * Whether git inside the step's container gets credentials through the
 * worker's per-run credential relay.
 *
 * - `auto` (the default): yes, when the worker has git credentials enabled.
 *   The credential is whatever the worker's source issues; with the worker
 *   host's own git it may be able to push, so this names no permission.
 * - `none`: the container gets no git credentials from Scarn.
 */
export const repoGitCredentialsSchema = z.enum(["auto", "none"]);
export type RepoGitCredentials = z.output<typeof repoGitCredentialsSchema>;

export const repoConfigInputSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("readOnly"),
      gitCredentials: repoGitCredentialsSchema.optional(),
      baseBranch: repoBaseBranchSchema.nullish(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("readWrite"),
      message: repoCommitMessageSchema.nullish(),
      onPushFailure: onPushFailureSchema.optional(),
      gitCredentials: repoGitCredentialsSchema.optional(),
      baseBranch: repoBaseBranchSchema.nullish(),
      workBranch: repoWorkBranchSchema.optional(),
    })
    .strict(),
]);

export const repoConfigSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("readOnly"),
      gitCredentials: repoGitCredentialsSchema,
      baseBranch: repoBaseBranchSchema.nullable(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("readWrite"),
      message: repoCommitMessageSchema.nullable(),
      onPushFailure: onPushFailureSchema,
      gitCredentials: repoGitCredentialsSchema,
      baseBranch: repoBaseBranchSchema.nullable(),
      workBranch: repoWorkBranchSchema,
    })
    .strict(),
]);

export type RepoConfigInput = z.input<typeof repoConfigInputSchema>;
export type RepoConfig = z.output<typeof repoConfigSchema>;

/**
 * Fills what an author left out: an omitted `repo` becomes the runtime's default
 * (`readWrite` for every runtime), an omitted
 * `onPushFailure` becomes `"fail"`, an omitted `message` becomes `null` and an
 * omitted `gitCredentials` becomes `"auto"`, an omitted `baseBranch` becomes
 * `null` and an omitted `workBranch` becomes `{ kind: "create" }`.
 */
export function resolveRepoConfig(input?: RepoConfigInput | null): RepoConfig {
  const mode = input?.mode ?? "readWrite";

  const gitCredentials =
    (input && "gitCredentials" in input ? input.gitCredentials : undefined) ??
    "auto";
  const baseBranch = input?.baseBranch ?? null;
  if (mode === "readOnly") {
    return { mode, gitCredentials, baseBranch };
  }

  const readWrite = input?.mode === "readWrite" ? input : undefined;
  return {
    mode,
    message: readWrite?.message ?? null,
    onPushFailure: readWrite?.onPushFailure ?? "fail",
    gitCredentials,
    baseBranch,
    workBranch: readWrite?.workBranch ?? { kind: "create" },
  };
}

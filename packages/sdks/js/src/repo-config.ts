import { z } from "zod";

/**
 * Wire schema for a step's repository access (`repo`): what the worker does
 * with the clone.
 *
 * - `none`: no repository. The worker does not clone, branch, commit or push.
 * - `readOnly`: clones and checks out the base branch, but creates no work
 *   branch, commits nothing and pushes nothing.
 * - `readWrite`: creates a work branch, commits and pushes. `message` is the
 *   commit message template (`{{input.…}}`, `{{result.…}}`,
 *   `{{workItem.title}}` and `{{workItem.platformKey}}` tokens only) and
 *   `onPushFailure` picks whether a failed push fails the step.
 *
 * Two shapes of the same data. `RepoConfigInput` is what an author or API client
 * sends and may leave things out; `RepoConfig` is what is stored, returned and
 * handed to the worker, fully resolved by `resolveRepoConfig`. A resolved
 * `RepoConfig` is also a valid `RepoConfigInput`, so a client can send back what
 * it read (hence a `null` message is accepted on input).
 *
 * Which modes each runtime accepts is `REPO_RUNTIME_SUPPORT`; a new runtime adds
 * a row there instead of changing the schema.
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

export type RepoMode = "none" | "readOnly" | "readWrite";
export type RepoOnPushFailure = "fail" | "warn";
export type RepoExecutionMode = "workspace" | "no_workspace";

const TOKEN_PATTERN = /\{\{([^}]+)\}\}/g;

/**
 * Every `{{…}}` token in `message` a commit message may not use, in order of
 * appearance: its root when that is not one of
 * `REPO_COMMIT_MESSAGE_TOKEN_ROOTS`, or the whole path for a `workItem` token
 * other than `REPO_COMMIT_MESSAGE_WORK_ITEM_KEYS`. Tokens are parsed the way
 * `renderPromptTemplate` renders them.
 */
export function findDisallowedCommitMessageTokenRoots(
  message: string,
): string[] {
  const disallowed: string[] = [];
  for (const match of message.matchAll(TOKEN_PATTERN)) {
    const path = match[1] ?? "";
    const [root = "", ...rest] = path.split(".");
    if (!REPO_COMMIT_MESSAGE_TOKEN_ROOTS.includes(root)) {
      disallowed.push(root);
    } else if (
      root === "workItem" &&
      (rest.length !== 1 ||
        !REPO_COMMIT_MESSAGE_WORK_ITEM_KEYS.includes(rest[0] ?? ""))
    ) {
      disallowed.push(path);
    }
  }
  return disallowed;
}

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

export const repoConfigInputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z.object({ mode: z.literal("readOnly") }).strict(),
  z
    .object({
      mode: z.literal("readWrite"),
      message: repoCommitMessageSchema.nullish(),
      onPushFailure: onPushFailureSchema.optional(),
    })
    .strict(),
]);

export const repoConfigSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z.object({ mode: z.literal("readOnly") }).strict(),
  z
    .object({
      mode: z.literal("readWrite"),
      message: repoCommitMessageSchema.nullable(),
      onPushFailure: onPushFailureSchema,
    })
    .strict(),
]);

export type RepoConfigInput = z.input<typeof repoConfigInputSchema>;
export type RepoConfig = z.output<typeof repoConfigSchema>;

type RepoRuntimeSupport = {
  readonly modes: readonly RepoMode[];
  readonly default: RepoMode;
  /** Why the modes outside `modes` are rejected. */
  readonly unsupportedBecause: string;
};

/** Which `repo` modes each execution mode accepts, and its default. */
export const REPO_RUNTIME_SUPPORT: Record<
  RepoExecutionMode,
  RepoRuntimeSupport
> = {
  workspace: {
    modes: ["readOnly", "readWrite"],
    default: "readWrite",
    unsupportedBecause: "a devcontainer step reads its config from the clone",
  },
  no_workspace: {
    modes: ["none"],
    default: "none",
    unsupportedBecause: "a host step has no clone",
  },
};

/**
 * Why `mode` cannot be used with `executionMode`, or `null` when the pair is
 * valid.
 */
export function repoRuntimeMismatch(
  executionMode: RepoExecutionMode,
  mode: RepoMode,
): string | null {
  const support = REPO_RUNTIME_SUPPORT[executionMode];
  return support.modes.includes(mode) ? null : support.unsupportedBecause;
}

/**
 * Fills what an author left out: an omitted `repo` becomes the runtime's default
 * (`readWrite` for `workspace`, `none` for `no_workspace`), an omitted
 * `onPushFailure` becomes `"fail"` and an omitted `message` becomes `null`.
 * Does not check the runtime pairing; that is the caller's invariant.
 */
export function resolveRepoConfig(
  executionMode: RepoExecutionMode,
  input?: RepoConfigInput | null,
): RepoConfig {
  const mode = input?.mode ?? REPO_RUNTIME_SUPPORT[executionMode].default;
  if (mode !== "readWrite") return { mode };

  const readWrite = input?.mode === "readWrite" ? input : undefined;
  return {
    mode,
    message: readWrite?.message ?? null,
    onPushFailure: readWrite?.onPushFailure ?? "fail",
  };
}

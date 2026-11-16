import type { ResolvedEnvironmentRefInput } from "@scarn/sdk/environment";
import {
  describeBaseBranchEnvProblem,
  findBaseBranchEnvProblems,
  isValidGitBranchName,
} from "@scarn/sdk/repo-config";
import { renderPromptTemplate } from "@scarn/sdk/definitions/steps";
import { RepoBranchInvalidError } from "./repo-branch-invalid-error";
import {
  MissingStepEnvError,
  resolveEnvVarValue,
  type ResolvedEnvVarValue,
} from "./resolve-step-env";

/**
 * Renders a step's `baseBranch` template (rule 5.3). `{{env.X}}` is one of
 * the step's environment vars, resolved as the agent would get it, but only
 * from `value` vars and non-secret `inherit` vars, since branch names reach
 * logs, git and the UI. A claimed run renders every token
 * ({@link renderBaseBranch}); a dry run has no input and no work item, so it
 * renders only `env` tokens ({@link renderEnvOnlyBaseBranch}).
 */

/** The parts of an environment var a base branch `env` token reads. */
export type BaseBranchEnvVar =
  | { name: string; source: "value"; value: string; secret: boolean }
  | {
      name: string;
      source: "inherit";
      from: string;
      secret: boolean;
      optional?: boolean | undefined;
      default?: string | undefined;
    }
  | { name: string; source: "secret" };

export type EnvOnlyBaseBranch =
  { kind: "rendered"; branch: string } | { kind: "unrendered"; note: string };

export const BASE_BRANCH_DEPENDS_ON_INPUT_NOTE =
  "base branch depends on input; not checked";

const TOKEN_PATTERN = /\{\{([^}]+)\}\}/g;

type WorkerEnv = Readonly<Record<string, string | undefined>>;

function tokenPaths(template: string): string[] {
  return [...template.matchAll(TOKEN_PATTERN)].map((match) =>
    (match[1] ?? "").trim(),
  );
}

/** `{{ env.X }}` as `{{env.X}}`: `renderPromptTemplate` reads paths verbatim. */
function trimTokens(template: string): string {
  return template.replace(
    TOKEN_PATTERN,
    (_token, path: string) => `{{${path.trim()}}}`,
  );
}

function resolveEnvToken(
  name: string,
  envVars: readonly BaseBranchEnvVar[],
  sources: { inputJson: unknown; workerEnv: WorkerEnv },
): ResolvedEnvVarValue | null {
  const entry = envVars.find((candidate) => candidate.name === name);
  if (!entry || entry.source === "secret" || entry.secret) return null;
  return resolveEnvVarValue(entry, sources);
}

/** Null when the step has no `baseBranch`. */
export function renderEnvOnlyBaseBranch(input: {
  template: string | null;
  envVars: readonly BaseBranchEnvVar[];
  workerEnv: WorkerEnv;
}): EnvOnlyBaseBranch | null {
  if (input.template === null) return null;
  const paths = tokenPaths(input.template);
  if (paths.some((path) => !path.startsWith("env."))) {
    return { kind: "unrendered", note: BASE_BRANCH_DEPENDS_ON_INPUT_NOTE };
  }

  const env: Record<string, string> = {};
  for (const path of paths) {
    const name = path.slice("env.".length);
    const entry = input.envVars.find((candidate) => candidate.name === name);
    const resolved =
      entry?.source === "value" && entry.value.includes("{{")
        ? null
        : resolveEnvToken(name, input.envVars, {
            inputJson: null,
            workerEnv: input.workerEnv,
          });
    if (resolved?.kind !== "resolved") {
      return {
        kind: "unrendered",
        note: `base branch needs env var ${name}, which a dry run cannot resolve; not checked`,
      };
    }
    env[name] = resolved.value;
  }

  const branch = renderPromptTemplate(trimTokens(input.template), { env });
  return isValidGitBranchName(branch)
    ? { kind: "rendered", branch }
    : {
        kind: "unrendered",
        note: `base branch "${branch}" is not a valid branch name; not checked`,
      };
}

/**
 * A dry run's base: the rendered `baseBranch` (rule 5.3), else null so the
 * launch falls through to `SCARN_BASE_WORK_BRANCH`, `baseWorkBranch` and the
 * remote default (rules 5.4–5.6), with a note saying why.
 */
export function dryRunBaseBranch(
  input: Parameters<typeof renderEnvOnlyBaseBranch>[0],
): { baseWorkBranch: string | null; baseBranchNote: string | null } {
  const rendered = renderEnvOnlyBaseBranch(input);
  if (rendered === null) return { baseWorkBranch: null, baseBranchNote: null };
  return rendered.kind === "rendered"
    ? { baseWorkBranch: rendered.branch, baseBranchNote: null }
    : { baseWorkBranch: null, baseBranchNote: rendered.note };
}

/** The vars a step's environment declares, before the launch resolves it. */
export function environmentRefVars(
  ref: ResolvedEnvironmentRefInput,
): BaseBranchEnvVar[] {
  if (ref === null) return [];
  if (ref.kind === "inline") return ref.envJson ?? [];
  return "content" in ref ? (ref.content.vars ?? []) : [];
}

/** A `baseBranch` `{{env.X}}` token names a var the environment doesn't declare. */
export class BaseBranchEnvUndeclaredError extends MissingStepEnvError {
  constructor(missing: readonly string[], environmentLabel?: string) {
    super(missing);
    this.message = `repo.baseBranch reads ${missing.map((name) => `{{env.${name}}}`).join(", ")}, which ${environmentLabel ?? "the step's environment"} does not declare. Declare it in the environment's vars.`;
    this.name = "BaseBranchEnvUndeclaredError";
  }
}

/**
 * The startup check on a claimed run's `baseBranch` (the environment can
 * change after publish): every `{{env.X}}` must name a declared var
 * (`MissingStepEnvError`, `SCARN_ENVIRONMENT_UNRESOLVED`) that is not secret
 * (`RepoBranchInvalidError`). `environmentLabel` names a named environment's
 * version in the error.
 */
export function assertBaseBranchFitsEnvironment(input: {
  template: string | null;
  envVars: readonly BaseBranchEnvVar[];
  environmentLabel?: string | undefined;
}): void {
  if (input.template === null) return;
  const problems = findBaseBranchEnvProblems(input.template, input.envVars);
  const undeclared = problems.filter(({ reason }) => reason === "undeclared");
  if (undeclared.length > 0) {
    throw new BaseBranchEnvUndeclaredError(
      undeclared.map(({ token }) => token.slice("env.".length)),
      input.environmentLabel,
    );
  }
  if (problems.length > 0) {
    throw new RepoBranchInvalidError(
      `repo.baseBranch is invalid: ${problems.map(describeBaseBranchEnvProblem).join("; ")}.`,
    );
  }
}

/**
 * A claimed run's `baseBranch`, rendered before checkout. `{{input.…}}` reads
 * the step's input, `{{env.X}}` the step's environment (see
 * {@link assertBaseBranchFitsEnvironment}) and `{{workItem.platformKey}}` the
 * work item, read only when the template names it. Null when the step has no
 * `baseBranch`.
 *
 * Throws `MissingStepEnvError` when an `env` var is undeclared or the worker
 * doesn't set it, and `RepoBranchInvalidError` when a token renders empty or
 * the result isn't a valid branch name.
 */
export async function renderBaseBranch(
  template: string | null,
  context: {
    inputJson: unknown;
    envVars: readonly BaseBranchEnvVar[];
    workerEnv: WorkerEnv;
    loadWorkItem?: (() => Promise<{ platformKey: string } | null>) | undefined;
    environmentLabel?: string | undefined;
  },
): Promise<string | null> {
  if (template === null) return null;
  assertBaseBranchFitsEnvironment({
    template,
    envVars: context.envVars,
    environmentLabel: context.environmentLabel,
  });

  const paths = tokenPaths(template);
  const env: Record<string, string> = {};
  const missing: string[] = [];
  for (const path of paths.filter((candidate) =>
    candidate.startsWith("env."),
  )) {
    const name = path.slice("env.".length);
    const resolved = resolveEnvToken(name, context.envVars, context);
    if (resolved?.kind === "missing") missing.push(resolved.description);
    if (resolved?.kind === "resolved") env[name] = resolved.value;
  }
  if (missing.length > 0) throw new MissingStepEnvError(missing);

  const usesWorkItem = paths.some((path) => path.startsWith("workItem."));
  const workItem =
    usesWorkItem && context.loadWorkItem ? await context.loadWorkItem() : null;
  const values = {
    input: context.inputJson,
    env,
    workItem: workItem ? { platformKey: workItem.platformKey } : null,
  };

  const empty = paths.filter(
    (path) => renderPromptTemplate(`{{${path}}}`, values) === "",
  );
  if (empty.length > 0) {
    throw new RepoBranchInvalidError(
      `repo.baseBranch "${template}" is invalid: ${empty.map((path) => `{{${path}}}`).join(", ")} rendered empty.`,
    );
  }
  const branch = renderPromptTemplate(trimTokens(template), values);
  if (!isValidGitBranchName(branch)) {
    throw new RepoBranchInvalidError(
      `repo.baseBranch "${template}" rendered "${branch}", which is not a valid branch name.`,
    );
  }
  return branch;
}

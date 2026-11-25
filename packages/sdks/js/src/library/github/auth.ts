/**
 * `GitHubAuth`: how `githubIssueImport` reaches GitHub. Only `apiKey` for
 * now: a personal access token sent as a Bearer header to GitHub's remote
 * MCP server. GitHub's MCP OAuth needs a confidential client, which managed
 * connections don't support yet.
 */
import { z } from "zod";
import type { EnvInherit, EnvSecret } from "../../definitions/steps/env";

/** A secret read at run time: a project secret or a worker variable. */
export type GitHubSecretRef = EnvSecret | EnvInherit<true>;

export type GitHubApiKey = {
  readonly type: "apiKey";
  /**
   * A fine-grained token with Issues: read on the repos (or a classic token
   * with `repo`, or `public_repo` for public repos), as `Env.secret(name)` or
   * `Env.inherit({ secret: true })`. A literal string throws: the step
   * definition is pushed and stored.
   */
  readonly token: GitHubSecretRef;
};

export type GitHubAuth = GitHubApiKey;

// eslint-disable-next-line local/no-unknown-parameter-type -- inspects author values
function hasKind(value: unknown, kind: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === kind
  );
}

const envSecretSchema = z.custom<EnvSecret>(
  (value) =>
    hasKind(value, "secret") &&
    typeof (value as { secretName?: unknown }).secretName === "string",
);

const secretInheritSchema = z.custom<EnvInherit<true>>(
  (value) =>
    hasKind(value, "inherit") &&
    (value as { secret?: unknown }).secret === true,
);

const TOKEN_MESSAGE =
  'token must be Env.secret("NAME") or Env.inherit({ secret: true }); a literal token would be stored with the step definition';

export const gitHubAuthSchema = z.strictObject({
  type: z.literal("apiKey", {
    error: 'type must be "apiKey"; GitHub OAuth is not supported yet',
  }),
  token: z.union([envSecretSchema, secretInheritSchema], {
    error: TOKEN_MESSAGE,
  }),
});

/**
 * `auth` checked. Throws, naming the step, when it's missing or invalid,
 * including a literal `token`.
 */
// eslint-disable-next-line local/no-unknown-parameter-type -- validates author input
export function parseGitHubAuth(stepKey: string, auth: unknown): GitHubAuth {
  const parsed = gitHubAuthSchema.safeParse(auth);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") ?? "";
    throw new Error(
      `githubIssueImport "${stepKey}": auth${path ? `.${path}` : ""}: ${issue?.message ?? "invalid"}`,
    );
  }
  return parsed.data;
}

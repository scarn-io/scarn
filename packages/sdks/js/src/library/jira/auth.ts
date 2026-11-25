/**
 * `JiraAuth`: how `jiraIssueImport` reaches Jira. `oauth` (the default) uses
 * the project's managed Atlassian connection; `apiKey` uses an Atlassian
 * account's email and a scoped API token as Jira Cloud basic auth.
 */
import { z } from "zod";
import { managedConnectionNameSchema } from "../../managed-connections";
import type { EnvInherit, EnvSecret } from "../../definitions/steps/env";

/** The managed connection `oauth` uses when `connection` is left out. */
export const DEFAULT_ATLASSIAN_CONNECTION = "atlassian";

/** A secret read at run time: a project secret or a worker variable. */
export type JiraSecretRef = EnvSecret | EnvInherit<true>;

/** A value that isn't secret: a literal or a run-time variable. */
export type JiraValueRef = string | EnvSecret | EnvInherit;

export type JiraOAuth = {
  readonly type: "oauth";
  /** The project's managed connection. Defaults to `"atlassian"`. */
  readonly connection?: string;
};

export type JiraApiKey = {
  readonly type: "apiKey";
  /** The Atlassian account's email, or a reference to it. */
  readonly email: JiraValueRef;
  /**
   * A scoped API token (`read:jira:agent-interface` and
   * `search:jira:agent-interface`), as `Env.secret(name)` or
   * `Env.inherit({ secret: true })`. A literal string throws: the step
   * definition is pushed and stored. The org admin must allow API-token
   * auth for the Atlassian MCP server.
   */
  readonly token: JiraSecretRef;
};

export type JiraAuth = JiraOAuth | JiraApiKey;

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

const envInheritSchema = z.custom<EnvInherit>((value) =>
  hasKind(value, "inherit"),
);

const secretInheritSchema = z.custom<EnvInherit<true>>(
  (value) =>
    hasKind(value, "inherit") &&
    (value as { secret?: unknown }).secret === true,
);

const TOKEN_MESSAGE =
  'token must be Env.secret("NAME") or Env.inherit({ secret: true }); a literal token would be stored with the step definition';

export const jiraAuthSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("oauth"),
    connection: managedConnectionNameSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("apiKey"),
    email: z.union([
      z.string().trim().min(1),
      envSecretSchema,
      envInheritSchema,
    ]),
    token: z.union([envSecretSchema, secretInheritSchema], {
      error: TOKEN_MESSAGE,
    }),
  }),
]);

/**
 * `auth` checked, with the default filled in. Throws, naming the step, when
 * it's invalid, including a literal `token`.
 */
export function parseJiraAuth(
  stepKey: string,
  auth: JiraAuth | undefined,
): JiraAuth {
  const parsed = jiraAuthSchema.safeParse(
    auth ?? { type: "oauth", connection: DEFAULT_ATLASSIAN_CONNECTION },
  );
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") ?? "";
    throw new Error(
      `jiraIssueImport "${stepKey}": auth${path ? `.${path}` : ""}: ${issue?.message ?? "invalid"}`,
    );
  }
  return parsed.data;
}

import type { z } from "zod";
import { ENV_VAR_NAME_PATTERN, isReservedEnvVarName } from "../../env-vars";
import {
  basicPlaceholderIssues,
  collectEnvPlaceholderNames,
  isEnvPlaceholderValue,
  mcpConnectionAuthSchema,
  openCodeMcpLocalConfigSchema,
  openCodeMcpRefConfigSchema,
  openCodeMcpRemoteConfigSchema,
  refConnectionAuthIssues,
  remoteConnectionAuthIssues,
} from "../../opencode-mcp";

/**
 * The server half of a `defineMcp` config: which server it is (`type` +
 * `name`) and, for `local`/`remote`, how OpenCode launches it. `type` and
 * `disabled` belong to `defineMcp`, so they are not authored here.
 */

const ownedFields = { type: true, disabled: true } as const;

const refFieldsSchema = openCodeMcpRefConfigSchema.omit({
  ...ownedFields,
  name: true,
});
const localFieldsSchema = openCodeMcpLocalConfigSchema.omit(ownedFields);
const remoteFieldsSchema = openCodeMcpRemoteConfigSchema
  .omit(ownedFields)
  .extend({ auth: mcpConnectionAuthSchema.optional() });

/** The shared OpenCode fields a `ref` applies on top of the repo's definition. */
export type McpRefServerFields = z.output<typeof refFieldsSchema>;
/** A `local` server: `command`, `cwd?`, `environment?` and the shared fields. */
export type McpLocalServerFields = z.output<typeof localFieldsSchema>;
/**
 * A `remote` server: `url`, `headers?`, `oauth?`, `auth?` and the shared
 * fields.
 */
export type McpRemoteServerFields = z.output<typeof remoteFieldsSchema>;

export type McpServerType = "ref" | "local" | "remote";

/**
 * A `defineMcp` server. For `ref`, `name` is the server's name in the repo's
 * MCP config. For `local`/`remote`, `name` only labels the server in errors;
 * the step's `mcps` key names it at runtime.
 */
export type McpServerDefinition =
  | {
      readonly type: "ref";
      readonly name: string;
      readonly server: Readonly<McpRefServerFields>;
    }
  | {
      readonly type: "local";
      readonly name: string;
      readonly server: Readonly<McpLocalServerFields>;
    }
  | {
      readonly type: "remote";
      readonly name: string;
      readonly server: Readonly<McpRemoteServerFields>;
    };

export type McpServerConfig =
  | ({ type: "ref"; name: string } & z.input<typeof refFieldsSchema>)
  | ({ type: "local"; name: string } & z.input<typeof localFieldsSchema>)
  | ({ type: "remote"; name: string } & z.input<typeof remoteFieldsSchema>);

const commonConfigKeys = new Set([
  "type",
  "name",
  "env",
  "optionalEnv",
  "vars",
  "healthChecks",
]);

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.map(String).join(".")}: ${issue.message}`
        : issue.message,
    )
    .join("; ");
}

function parseFields<T>(
  name: string,
  schema: z.ZodType<T>,
  config: McpServerConfig,
): T {
  const fields = Object.fromEntries(
    Object.entries(config).filter(([key]) => !commonConfigKeys.has(key)),
  );
  const parsed = schema.safeParse(fields);
  if (!parsed.success) {
    throw new Error(`defineMcp "${name}": ${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

function assertConnectionAuth(
  name: string,
  issues: readonly { path: string; message: string }[],
): void {
  if (issues.length === 0) return;
  throw new Error(
    `defineMcp "${name}": ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
  );
}

/**
 * Checks a `remote` config's `auth` before its fields are parsed, so a
 * `workerVars` beside `auth` gets a specific message rather than
 * "unrecognized key". An invalid `auth` is left to the parse.
 */
function assertRemoteConnectionAuth(
  name: string,
  config: Extract<McpServerConfig, { type: "remote" }>,
): void {
  const auth = mcpConnectionAuthSchema.safeParse(config.auth);
  if (!auth.success) return;
  if (typeof config.url !== "string") {
    throw new Error(
      `defineMcp "${name}": url is required with auth; write the ${auth.data.connection} connection's resource URL explicitly.`,
    );
  }
  assertConnectionAuth(
    name,
    remoteConnectionAuthIssues({ ...config, auth: auth.data }),
  );
}

function assertPlaceholders(
  name: string,
  field: "environment" | "headers",
  values: Readonly<Record<string, string>> | undefined,
): void {
  for (const [key, value] of Object.entries(values ?? {})) {
    if (isEnvPlaceholderValue(value)) continue;
    const forms =
      field === "headers"
        ? "{env:VAR} or {basic:USER_VAR:PASS_VAR}"
        : "{env:VAR}";
    throw new Error(
      `defineMcp "${name}": ${field}.${key} must be written as ${forms}; a literal ${field} value would be stored in plaintext.`,
    );
  }
}

/**
 * The `{env:VAR}` and `{basic:USER_VAR:PASS_VAR}` names an inline server
 * reads, which compile into required
 * env entries tagged with the server's key. Empty for a `ref`: the worker
 * infers those from the repo's definition.
 */
export function inferredMcpEnv(definition: McpServerDefinition): string[] {
  return definition.type === "ref"
    ? []
    : collectEnvPlaceholderNames(definition.server);
}

function assertInferredEnv(definition: McpServerDefinition): void {
  for (const variable of inferredMcpEnv(definition)) {
    if (!ENV_VAR_NAME_PATTERN.test(variable)) {
      throw new Error(
        `defineMcp "${definition.name}": {env:${variable}} must name a variable matching ${String(ENV_VAR_NAME_PATTERN)}.`,
      );
    }
    if (isReservedEnvVarName(variable)) {
      throw new Error(
        `defineMcp "${definition.name}": {env:${variable}} reads a variable reserved for Scarn.`,
      );
    }
  }
}

/**
 * Validates a `defineMcp` config's server half and returns it with its
 * OpenCode fields parsed. Throws on an unknown `type`, an invalid field, a
 * literal (non-`{env:VAR}`) `environment` or `headers` value, a
 * placeholder naming an invalid or reserved variable, or an `auth` the
 * server can't carry (see `remoteConnectionAuthIssues`).
 */
export function parseMcpServer(config: McpServerConfig): McpServerDefinition {
  if (typeof config.name !== "string" || config.name.trim().length === 0) {
    throw new Error("defineMcp: name must be a non-empty string.");
  }
  const { name } = config;
  let definition: McpServerDefinition;
  switch (config.type) {
    case "ref": {
      const server = parseFields(name, refFieldsSchema, config);
      assertConnectionAuth(name, refConnectionAuthIssues(server));
      definition = { type: "ref", name, server };
      break;
    }
    case "local": {
      const server = parseFields(name, localFieldsSchema, config);
      assertPlaceholders(name, "environment", server.environment);
      definition = { type: "local", name, server };
      break;
    }
    case "remote": {
      assertRemoteConnectionAuth(name, config);
      const server = parseFields(name, remoteFieldsSchema, config);
      assertPlaceholders(name, "headers", server.headers);
      definition = { type: "remote", name, server };
      break;
    }
    default:
      throw new Error(
        `defineMcp "${name}": type must be "ref", "local" or "remote".`,
      );
  }
  assertConnectionAuth(
    name,
    basicPlaceholderIssues({ ...definition.server, type: definition.type }),
  );
  assertInferredEnv(definition);
  return definition;
}

/**
 * Step-declared MCP servers, in OpenCode v2's native `mcp.servers.<name>` entry
 * shape, plus a Scarn-only `ref` entry. The worker resolves refs before
 * passing the resulting `local`/`remote` entries to the runtime overlay.
 * Authored entries carry optional Scarn-only `workerVars`; resolved entries
 * never do. The native `local`/`remote` schemas mirror the v2 config schema.
 * `test/opencode-config-shapes.test.ts` fails typecheck if they drift from
 * `@opencode/client`'s generated `ConfigEntry` type.
 */
import { z } from "zod";
import { inheritEnvVarSchema, MAX_ENV_VARS } from "./env-vars";
import {
  managedConnectionNameSchema,
  normalizeMcpResourceUrl,
} from "./managed-connections";

/**
 * Scarn-only: the server is authenticated by the project's managed
 * connection named `connection`. Authored on `ref` and `remote` entries only;
 * resolution removes it before anything reaches OpenCode.
 */
export const mcpConnectionAuthSchema = z.strictObject({
  connection: managedConnectionNameSchema,
});

export type McpConnectionAuth = z.infer<typeof mcpConnectionAuthSchema>;

const workerVarsSchema = z
  .array(inheritEnvVarSchema.safeExtend({ applies: z.literal("agent") }))
  .max(MAX_ENV_VARS)
  .refine(
    (entries) =>
      new Set(entries.map((entry) => entry.name)).size === entries.length,
    { message: "MCP worker variable names must be unique" },
  );

const nonEmptyStringSchema = z.string().trim().min(1);

const mcpStringMapSchema = z.record(z.string(), z.string());

const positiveIntSchema = z.int().gt(0).max(Number.MAX_SAFE_INTEGER);

export const openCodeMcpTimeoutSchema = z
  .object({
    startup: positiveIntSchema.optional(),
    catalog: positiveIntSchema.optional(),
    execution: positiveIntSchema.optional(),
  })
  .strict();

export const openCodeMcpProtocolSchema = z.enum([
  "legacy",
  "auto",
  "2026-07-28",
]);

const sharedServerFields = {
  disabled: z.boolean().optional(),
  codemode: z.boolean().optional(),
  timeout: openCodeMcpTimeoutSchema.optional(),
  protocol: openCodeMcpProtocolSchema.optional(),
};

/** A `local` entry, exactly as OpenCode reads it. */
export const openCodeMcpLocalConfigSchema = z
  .object({
    type: z.literal("local"),
    command: z.array(nonEmptyStringSchema).min(1),
    cwd: z.string().optional(),
    environment: mcpStringMapSchema.optional(),
    ...sharedServerFields,
  })
  .strict();

export const openCodeMcpOAuthConfigSchema = z
  .object({
    client_id: z.string().optional(),
    client_secret: z.string().optional(),
    scope: z.string().optional(),
    callback_port: positiveIntSchema.optional(),
    redirect_uri: z.string().optional(),
    auth_server_metadata_url: z.string().optional(),
  })
  .strict();

/** A `remote` entry, exactly as OpenCode reads it. */
export const openCodeMcpRemoteConfigSchema = z
  .object({
    type: z.literal("remote"),
    url: z.string(),
    headers: mcpStringMapSchema.optional(),
    oauth: z.union([openCodeMcpOAuthConfigSchema, z.literal(false)]).optional(),
    ...sharedServerFields,
  })
  .strict();

/**
 * A reference to an MCP server defined in the repository's own MCP config
 * files (`.opencode/opencode.json`, `.mcp.json`, `.codex/config.toml`, …).
 * `name` defaults to the step's server key. The worker resolves refs into
 * `local`/`remote` entries before launch, applying the shared fields on top;
 * `name` and `workerVars` are Scarn-only and dropped during resolution, so a
 * ref never reaches OpenCode.
 */
export const openCodeMcpRefConfigSchema = z
  .object({
    type: z.literal("ref"),
    name: nonEmptyStringSchema.optional(),
    workerVars: workerVarsSchema.optional(),
    auth: mcpConnectionAuthSchema.optional(),
    ...sharedServerFields,
  })
  .strict();

export const openCodeResolvedMcpServerConfigSchema = z.discriminatedUnion(
  "type",
  [openCodeMcpLocalConfigSchema, openCodeMcpRemoteConfigSchema],
);

export const openCodeResolvedMcpServersSchema = z.record(
  z.string(),
  openCodeResolvedMcpServerConfigSchema,
);

/**
 * Why an authored `remote` entry can't carry its `auth`, or null when it
 * can: its `url` must be usable as a connection's resource (an absolute
 * `http(s)` URL with no query string, fragment or credentials), and the
 * connection replaces `headers`, `oauth` and `workerVars` rather than
 * merging with them. Whether `url` is the named connection's resource is
 * only known once the connection is loaded, so the worker checks that.
 */
export function remoteConnectionAuthIssues(entry: {
  url: string;
  auth?: McpConnectionAuth | undefined;
  headers?: unknown;
  oauth?: unknown;
  workerVars?: unknown;
}): { path: string; message: string }[] {
  if (entry.auth === undefined) return [];
  const { connection } = entry.auth;
  const issues: { path: string; message: string }[] = [];
  if (normalizeMcpResourceUrl(entry.url) === null) {
    issues.push({
      path: "url",
      message: `must be an absolute http(s) URL with no query string, fragment or credentials when auth is set; the ${connection} connection authenticates the server`,
    });
  }
  for (const field of ["headers", "oauth", "workerVars"] as const) {
    if (entry[field] === undefined) continue;
    issues.push({
      path: field,
      message: `must be absent when auth is set; the ${connection} connection authenticates the server`,
    });
  }
  return issues;
}

/** Why an authored `ref` entry can't carry its `auth`, or an empty list. */
export function refConnectionAuthIssues(entry: {
  auth?: McpConnectionAuth | undefined;
  workerVars?: unknown;
}): { path: string; message: string }[] {
  if (entry.auth === undefined || entry.workerVars === undefined) return [];
  return [
    {
      path: "workerVars",
      message: `must be absent when auth is set; the ${entry.auth.connection} connection authenticates the server`,
    },
  ];
}

const addIssues = (
  issues: { path: string; message: string }[],
  ctx: z.RefinementCtx,
): void => {
  for (const issue of issues) {
    ctx.addIssue({
      code: "custom",
      path: [issue.path],
      message: issue.message,
    });
  }
};

/**
 * The authored/stored shape: `local`, `remote`, or an unresolved `ref`.
 * `remote` and `ref` may carry Scarn-only `auth`, which never reaches
 * OpenCode.
 */
export const openCodeMcpServerConfigSchema = z.discriminatedUnion("type", [
  openCodeMcpLocalConfigSchema.extend({
    workerVars: workerVarsSchema.optional(),
  }),
  openCodeMcpRemoteConfigSchema
    .extend({
      workerVars: workerVarsSchema.optional(),
      auth: mcpConnectionAuthSchema.optional(),
    })
    .superRefine((entry, ctx) => {
      addIssues(remoteConnectionAuthIssues(entry), ctx);
    }),
  openCodeMcpRefConfigSchema.superRefine((entry, ctx) => {
    addIssues(refConnectionAuthIssues(entry), ctx);
  }),
]);

export const openCodeMcpServersSchema = z.record(
  z.string(),
  openCodeMcpServerConfigSchema,
);

const ENV_PLACEHOLDER_PATTERN = /\{env:[A-Za-z_][A-Za-z0-9_]*\}/gu;
const ENV_PLACEHOLDER_NAME_PATTERN = /\{env:([^}]+)\}/gu;
const AUTH_SCHEME_PATTERN = /^(?:bearer|basic|token)\s+/iu;

/**
 * Whether `value` carries nothing but `{env:VAR}` placeholders, optionally
 * behind an HTTP auth scheme (`Bearer {env:TOKEN}`). Anything else is a
 * literal that would be stored in plaintext, so a `local` server's
 * `environment` values and a `remote` server's `headers` values must pass it.
 */
export function isEnvPlaceholderValue(value: string): boolean {
  if (value.match(ENV_PLACEHOLDER_PATTERN) === null) return false;
  return (
    value
      .trim()
      .replace(AUTH_SCHEME_PATTERN, "")
      .replace(ENV_PLACEHOLDER_PATTERN, "")
      .trim() === ""
  );
}

/** A JSON-like value that may hold `{env:VAR}` placeholders in its strings. */
export type EnvPlaceholderSource =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly EnvPlaceholderSource[]
  | { readonly [key: string]: EnvPlaceholderSource };

/** Every variable name a value reads as `{env:VAR}`, at any depth, sorted. */
export function collectEnvPlaceholderNames(
  value: EnvPlaceholderSource,
): string[] {
  const names = new Set<string>();
  const visit = (item: EnvPlaceholderSource): void => {
    if (typeof item === "string") {
      for (const match of item.matchAll(ENV_PLACEHOLDER_NAME_PATTERN)) {
        if (match[1] !== undefined) names.add(match[1]);
      }
    } else if (typeof item === "object" && item !== null) {
      for (const child of Object.values(item)) visit(child);
    }
  };
  visit(value);
  return [...names].sort();
}

export type OpenCodeMcpRefConfig = z.infer<typeof openCodeMcpRefConfigSchema>;
export type OpenCodeMcpServerConfig = z.infer<
  typeof openCodeMcpServerConfigSchema
>;
export type OpenCodeMcpServers = z.infer<typeof openCodeMcpServersSchema>;
export type ResolvedOpenCodeMcpServerConfig = z.infer<
  typeof openCodeResolvedMcpServerConfigSchema
>;
export type ResolvedOpenCodeMcpServers = z.infer<
  typeof openCodeResolvedMcpServersSchema
>;

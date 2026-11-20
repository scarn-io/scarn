import type { ManagedConnectionName } from "@scarn/sdk/managed-connections";
import {
  collectEnvPlaceholderNames,
  type OpenCodeMcpRefConfig,
  type OpenCodeMcpServers,
  type ResolvedOpenCodeMcpServerConfig,
  type ResolvedOpenCodeMcpServers,
} from "../../../common/contracts/opencode-mcp";
import type {
  DiscoveredAgentTools,
  InlineSecret,
} from "../../../project/agent-tools/domain/discovered-agent-tools";

/**
 * Builds the MCP servers a step's OpenCode config carries, from the step's
 * own entries and the repository's discovered servers
 * (`discoverRepoAgentTools`), which are the only source a ref resolves
 * against — the user's global OpenCode config is never consulted.
 *
 *   - A `{ type: "ref" }` entry is looked up by `name` (defaulting to its
 *     server key) among the discovered servers and replaced by the full
 *     v2 definition; the ref's shared fields (`disabled`, `codemode`,
 *     `timeout`, `protocol`) are laid on top. Its Scarn-only `name` is
 *     dropped. A ref never reaches OpenCode. One that matches nothing throws
 *     {@link McpServerRefNotFoundError}.
 *   - Inline `local`/`remote` entries pass through without their Scarn-only
 *     `workerVars` and `auth`.
 *   - An entry with `auth: { connection }` must resolve to a `remote`
 *     ({@link McpConnectionAuthNotRemoteError}). Its definition's `headers`
 *     and `oauth` are dropped, so neither the repository's credentials nor
 *     OpenCode's native OAuth is ever used for it, and it is recorded in
 *     `connectionAuth` with its resolved URL. The server checks that URL
 *     against the connection's resource at launch registration, not here.
 *   - Every other enabled remote is recorded in `remotesWithoutAuth` by key
 *     and URL, so registration can refuse one that points at a connection's
 *     URL without `auth`.
 *   - Every discovered server whose name is not one of the step's keys is
 *     emitted with `disabled: true`, so a step only gets the servers it names
 *     — including servers OpenCode would otherwise load from the clone's own
 *     `.opencode/opencode.json[c]`. A ref aliased under another key
 *     (`db: { type: "ref", name: "postgres" }`) runs as `db` only; the
 *     original `postgres` is disabled.
 */

export class McpServerRefNotFoundError extends Error {
  readonly ref: string;
  readonly lookupName: string;
  readonly searched: readonly string[];

  constructor(input: {
    ref: string;
    lookupName: string;
    tools: DiscoveredAgentTools;
  }) {
    const searched = input.tools.searched.map((file) =>
      file.present
        ? `${file.file} (${file.path})`
        : `${file.file} (not present)`,
    );
    const skippedHere = input.tools.skipped.filter(
      (entry) => entry.kind === "server" && entry.name === input.lookupName,
    );
    const target =
      input.ref === input.lookupName
        ? `"${input.ref}"`
        : `"${input.ref}" (name "${input.lookupName}")`;
    const skippedNote = skippedHere
      .map(
        (entry) =>
          ` It is defined in ${entry.source} but could not be used: ${entry.reason}.`,
      )
      .join("");
    super(
      `MCP server ref ${target} was not found in the repository's MCP configs. Searched: ` +
        (searched.length > 0 ? searched.join(", ") : "no files") +
        "." +
        skippedNote +
        ' Define it in one of these files at the repository root, or declare it inline with defineMcp({ type: "local" | "remote" }).',
    );
    this.name = "McpServerRefNotFoundError";
    this.ref = input.ref;
    this.lookupName = input.lookupName;
    this.searched = searched;
  }
}

const INLINE_SOURCE = "the step definition";

/** Failure code for a step MCP server whose `auth` can't be used. */
export const MCP_CONNECTION_AUTH_INVALID_ERROR_CODE =
  "SCARN_MCP_CONNECTION_AUTH_INVALID";

/** The named error a pipeline's `retry`/`catch` matches for an unusable connection auth. */
export const MCP_CONNECTION_AUTH_INVALID_ERROR_NAME =
  "Scarn.McpConnectionAuthInvalid";

function authSnippet(connection: ManagedConnectionName): string {
  return `auth: { connection: "${connection}" }`;
}

export class McpConnectionAuthNotRemoteError extends Error {
  readonly code = MCP_CONNECTION_AUTH_INVALID_ERROR_CODE;
  readonly key: string;
  readonly connection: ManagedConnectionName;
  readonly source: string;

  constructor(input: {
    key: string;
    connection: ManagedConnectionName;
    source: string;
    type: ResolvedOpenCodeMcpServerConfig["type"];
  }) {
    super(
      `MCP server "${input.key}" uses the project's "${input.connection}" connection (${authSnippet(input.connection)}), ` +
        `but its definition in ${input.source} is a ${input.type} server. A connection can only authenticate a remote server. ` +
        `Change the definition in ${input.source} to a remote server with the connection's URL, ` +
        `or declare it inline with defineMcp({ type: "remote", url: "<connection URL>", ${authSnippet(input.connection)} }).`,
    );
    this.name = "McpConnectionAuthNotRemoteError";
    this.key = input.key;
    this.connection = input.connection;
    this.source = input.source;
  }
}

const SHARED_SERVER_FIELDS = [
  "disabled",
  "codemode",
  "timeout",
  "protocol",
] as const satisfies readonly (keyof OpenCodeMcpRefConfig &
  keyof ResolvedOpenCodeMcpServerConfig)[];

type SharedServerField = (typeof SHARED_SERVER_FIELDS)[number];

function applySharedFields(
  resolved: ResolvedOpenCodeMcpServerConfig,
  ref: OpenCodeMcpRefConfig,
): ResolvedOpenCodeMcpServerConfig {
  const overrides = Object.fromEntries(
    SHARED_SERVER_FIELDS.filter((field) => ref[field] !== undefined).map(
      (field) => [field, ref[field]],
    ),
  ) as Partial<Pick<OpenCodeMcpRefConfig, SharedServerField>>;
  return { ...resolved, ...overrides };
}

/** Where one ref was found. Carries no part of the definition, so it is safe to log. */
export type ResolvedMcpServerRef = {
  key: string;
  lookupName: string;
  /** Repo-relative file the definition came from. */
  source: string;
  type: ResolvedOpenCodeMcpServerConfig["type"];
  /** Credentials removed from the definition during discovery, by key. */
  inlineSecrets: InlineSecret[];
  /** Variables the definition reads as `{env:X}`, sorted. */
  requiredEnv: string[];
};

/**
 * An enabled step MCP server authenticated by a managed connection. Apart
 * from `url`, it carries only names, never a value, so it is safe to log
 * without `url`.
 */
export type ResolvedConnectionAuth = {
  key: string;
  connection: ManagedConnectionName;
  /** The definition's URL, before it is replaced with the relay's. */
  url: string;
  /** Repo-relative file of a ref's definition, or "the step definition". */
  source: string;
  /** Header names the definition set, dropped in favour of the connection. */
  droppedHeaders: string[];
  /** Whether the definition set `oauth`, dropped in favour of the connection. */
  droppedOAuth: boolean;
};

export type ResolveStepMcpServersResult = {
  /** `null` when the step declares nothing and the repository defines nothing. */
  servers: ResolvedOpenCodeMcpServers | null;
  resolvedRefs: ResolvedMcpServerRef[];
  /** Discovered servers emitted as `disabled: true`, by name. */
  disabledServers: string[];
  /** Enabled entries with `auth: { connection }`, in step order. */
  connectionAuth: ResolvedConnectionAuth[];
  /** Enabled step entries that resolved to a remote without `auth`, by key and URL. */
  remotesWithoutAuth: { key: string; url: string }[];
};

function applyConnectionAuth(input: {
  key: string;
  connection: ManagedConnectionName;
  source: string;
  resolved: ResolvedOpenCodeMcpServerConfig;
}): {
  server: ResolvedOpenCodeMcpServerConfig;
  auth: ResolvedConnectionAuth;
} {
  const { key, connection, source, resolved } = input;
  if (resolved.type !== "remote") {
    throw new McpConnectionAuthNotRemoteError({
      key,
      connection,
      source,
      type: resolved.type,
    });
  }
  const { headers, oauth, ...server } = resolved;
  return {
    server,
    auth: {
      key,
      connection,
      url: server.url,
      source,
      droppedHeaders: Object.keys(headers ?? {}),
      droppedOAuth: oauth !== undefined,
    },
  };
}

export function resolveStepMcpServers(input: {
  servers: OpenCodeMcpServers | null | undefined;
  tools: DiscoveredAgentTools;
}): ResolveStepMcpServersResult {
  const discovered = new Map(
    input.tools.servers.map((server) => [server.name, server]),
  );
  const servers: ResolvedOpenCodeMcpServers = {};
  const resolvedRefs: ResolvedMcpServerRef[] = [];
  const connectionAuth: ResolvedConnectionAuth[] = [];
  const remotesWithoutAuth: { key: string; url: string }[] = [];
  const recordWithoutAuth = (
    key: string,
    server: ResolvedOpenCodeMcpServerConfig,
  ) => {
    if (server.type === "remote" && server.disabled !== true) {
      remotesWithoutAuth.push({ key, url: server.url });
    }
  };
  const used = new Set<string>();

  for (const [key, entry] of Object.entries(input.servers ?? {})) {
    used.add(key);
    if (entry.type === "local") {
      const native = { ...entry };
      delete native.workerVars;
      servers[key] = native;
      continue;
    }

    if (entry.type === "remote") {
      const { auth } = entry;
      const native = { ...entry };
      delete native.workerVars;
      delete native.auth;
      if (auth === undefined) {
        servers[key] = native;
        recordWithoutAuth(key, native);
        continue;
      }
      const applied = applyConnectionAuth({
        key,
        connection: auth.connection,
        source: INLINE_SOURCE,
        resolved: native,
      });
      servers[key] = applied.server;
      if (applied.server.disabled !== true) connectionAuth.push(applied.auth);
      continue;
    }

    const lookupName = entry.name ?? key;
    const match = discovered.get(lookupName);
    if (match === undefined) {
      throw new McpServerRefNotFoundError({
        ref: key,
        lookupName,
        tools: input.tools,
      });
    }
    const resolved = applySharedFields(match.config, entry);
    let server = resolved;
    let requiredEnv = match.requiredEnv;
    if (entry.auth !== undefined) {
      const applied = applyConnectionAuth({
        key,
        connection: entry.auth.connection,
        source: match.source,
        resolved,
      });
      server = applied.server;
      requiredEnv = collectEnvPlaceholderNames(server);
      if (server.disabled !== true) connectionAuth.push(applied.auth);
    } else {
      recordWithoutAuth(key, server);
    }
    servers[key] = server;
    resolvedRefs.push({
      key,
      lookupName,
      source: match.source,
      type: match.config.type,
      inlineSecrets: match.inlineSecrets,
      requiredEnv,
    });
  }

  const disabledServers: string[] = [];
  for (const server of input.tools.servers) {
    if (used.has(server.name)) continue;
    servers[server.name] = { ...server.config, disabled: true };
    disabledServers.push(server.name);
  }

  return {
    servers: Object.keys(servers).length > 0 ? servers : null,
    resolvedRefs,
    disabledServers,
    connectionAuth,
    remotesWithoutAuth,
  };
}

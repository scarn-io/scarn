import {
  appliesToAgent,
  appliesToSetup,
  isMaskedEnvVar,
  isUninheritableWorkerEnvVarName,
  type EnvVarSpec,
} from "@scarn/sdk/env-vars";
import { renderPromptTemplate } from "@scarn/sdk/definitions/steps";
import type { ManagedConnectionName } from "@scarn/sdk/managed-connections";
import type {
  OpenCodeMcpServerConfig,
  OpenCodeMcpServers,
} from "../../../common/contracts/opencode-mcp";
import type { TaskKind } from "../contracts/task-run-contracts";

/**
 * Resolves an environment's declared vars against a run's input and the worker's
 * environment. Pure: the worker host's env (`.scarn/.env` over `process.env`)
 * is passed in as `workerEnv`, never read here.
 *
 * - `value`: the template rendered against `{ input }`.
 * - `inherit`: `workerEnv[from]`, else `default`, else omitted when
 *   `optional`, else reported as missing.
 *
 * `applies` routes each resolved variable: `agent` into `stepEnv` (the agent
 * or code step), `setup` into `setupEnv` (the `devcontainer up` process),
 * `both` into both.
 *
 * Every missing required name, tagged with an `mcp` key or not, is collected
 * into a single {@link MissingStepEnvError}; its message names variables (and
 * their MCP), never values.
 */

/** One planned MCP server ref: the variables its repo definition reads (`{env:X}`). */
export type McpEnvRef = {
  key: string;
  requiredEnv: readonly string[];
};

export type ResolvedStepEnv = {
  /** Every variable that applies to the agent, secret or not: what is injected into the run. */
  stepEnv: Record<string, string>;
  /** Every variable that applies to setup: the host env of `devcontainer up`. */
  setupEnv: Record<string, string>;
  /** The non-secret subset of `stepEnv`, safe to render into the agent prompt. */
  promptEnv: Record<string, string>;
  /** Resolved values of secret entries, agent or setup, to register with the log masker. */
  secretValues: string[];
  /**
   * Names in `stepEnv` that only the step's MCP servers read (inferred or
   * `workerVars`, not declared by the step). A code step's runner never
   * gets them: its MCP calls go through the worker-side bridge.
   */
  mcpOnlyEnvNames?: readonly string[] | undefined;
};

/**
 * The env a step's own process gets: a code step's runner leaves out the
 * variables only its MCP servers read, which stay on the worker side of the
 * MCP bridge (`environment.mcpCalls.env`). Every other kind gets `stepEnv`.
 */
export function runnerStepEnv(
  kind: TaskKind,
  resolved: Pick<ResolvedStepEnv, "stepEnv" | "mcpOnlyEnvNames">,
): Record<string, string> {
  if (kind !== "code") return resolved.stepEnv;
  const mcpOnly = new Set(resolved.mcpOnlyEnvNames ?? []);
  return Object.fromEntries(
    Object.entries(resolved.stepEnv).filter(([name]) => !mcpOnly.has(name)),
  );
}

export class MissingStepEnvError extends Error {
  readonly missing: readonly string[];

  constructor(
    missing: readonly string[],
    options: { includesSecrets?: boolean } = {},
  ) {
    super(
      `Step declares required environment variables that are not set on the worker: ${missing.join(", ")}. ` +
        "Set them in .scarn/.env or the worker's environment, or mark them optional." +
        (options.includesSecrets
          ? " For a project secret, set it in .scarn/.env or save it as a project secret."
          : ""),
    );
    this.name = "MissingStepEnvError";
    this.missing = missing;
  }
}

function describeMissingSecret(
  entry: Extract<ResolvableEnvVar, { source: "secret" }>,
): string {
  const owner = entry.secretName === entry.name ? "" : ` for ${entry.name}`;
  return `${entry.secretName} (project secret${owner})`;
}

function describeMissing(
  entry: Extract<ResolvableEnvVar, { source: "inherit" }>,
): string {
  const owners = [
    ...(entry.from === entry.name ? [] : [entry.name]),
    ...(entry.mcp === undefined ? [] : [`MCP "${entry.mcp}"`]),
  ];
  return owners.length > 0
    ? `${entry.from} (for ${owners.join(", ")})`
    : entry.from;
}

/** Where one var's value comes from: the run's input, the worker, project secrets. */
export type StepEnvSources = {
  inputJson: unknown;
  workerEnv: Readonly<Record<string, string | undefined>>;
  /** Project secret values by secret name (see `resolveSecretEnv`); never `workerEnv`. */
  projectSecrets?: Readonly<Record<string, string>> | undefined;
};

/** The parts of a declared var {@link resolveEnvVarValue} reads. */
export type ResolvableEnvVar =
  | { name: string; source: "value"; value: string }
  | {
      name: string;
      source: "inherit";
      from: string;
      optional?: boolean | undefined;
      default?: string | undefined;
      mcp?: string | undefined;
    }
  | { name: string; source: "secret"; secretName: string };

export type ResolvedEnvVarValue =
  | { kind: "resolved"; value: string }
  | { kind: "omitted" }
  | { kind: "missing"; description: string; secret: boolean };

/**
 * One declared var's value, as the agent would get it. `omitted`: an
 * optional `inherit` var the worker doesn't set. `missing`: a required one,
 * or a project secret that wasn't supplied.
 */
export function resolveEnvVarValue(
  entry: ResolvableEnvVar,
  sources: StepEnvSources,
): ResolvedEnvVarValue {
  if (entry.source === "secret") {
    const value = sources.projectSecrets?.[entry.secretName];
    return value === undefined
      ? {
          kind: "missing",
          description: describeMissingSecret(entry),
          secret: true,
        }
      : { kind: "resolved", value };
  }
  if (entry.source === "value") {
    return {
      kind: "resolved",
      value: renderPromptTemplate(entry.value, { input: sources.inputJson }),
    };
  }
  if (isUninheritableWorkerEnvVarName(entry.from)) {
    throw new Error(
      `Step env "${entry.name}" cannot inherit worker variable "${entry.from}": SCARN_* variables are reserved for the worker.`,
    );
  }
  const value = sources.workerEnv[entry.from] ?? entry.default;
  if (value !== undefined) return { kind: "resolved", value };
  return entry.optional
    ? { kind: "omitted" }
    : { kind: "missing", description: describeMissing(entry), secret: false };
}

export function resolveStepEnv(
  input: StepEnvSources & {
    envVars: readonly EnvVarSpec[] | null | undefined;
  },
): ResolvedStepEnv {
  const stepEnv: Record<string, string> = {};
  const setupEnv: Record<string, string> = {};
  const promptEnv: Record<string, string> = {};
  const secretValues: string[] = [];
  const missing: string[] = [];
  let missingSecret = false;

  for (const entry of input.envVars ?? []) {
    const outcome = resolveEnvVarValue(entry, input);
    if (outcome.kind === "omitted") continue;
    if (outcome.kind === "missing") {
      missing.push(outcome.description);
      missingSecret ||= outcome.secret;
      continue;
    }
    const resolved = outcome.value;

    const toAgent = appliesToAgent(entry.applies);
    if (toAgent) stepEnv[entry.name] = resolved;
    if (appliesToSetup(entry.applies)) setupEnv[entry.name] = resolved;
    if (isMaskedEnvVar(entry)) {
      if (resolved.length > 0) secretValues.push(resolved);
    } else if (toAgent) {
      promptEnv[entry.name] = resolved;
    }
  }

  if (missing.length > 0) {
    throw new MissingStepEnvError(missing, { includesSecrets: missingSecret });
  }

  return { stepEnv, setupEnv, promptEnv, secretValues };
}

/**
 * D3: every `{env:X}` a ref'd server's repo definition reads is a required,
 * secret, inherited variable of that MCP, unless the step already declares
 * `X` itself for the agent (D4: the step's own entry wins; a setup-only entry
 * does not reach the agent, so the MCP still gets its own). A name read by
 * several servers is unowned. Explicit declarations suppress inference only
 * on their own server; across servers, required and secret win. A
 * `workerVars` project secret or value is taken as declared; two servers
 * may share one only when both give it the same source.
 *
 * A server with `auth: { connection }` is authenticated by the connection
 * alone (decision 9): it contributes no `workerVars`, and its ref's
 * `requiredEnv` already excludes the variables of the dropped headers.
 */
export function withInferredMcpEnv(
  envJson: readonly EnvVarSpec[] | null | undefined,
  refs: readonly McpEnvRef[],
  servers?: OpenCodeMcpServers | null,
): EnvVarSpec[] {
  const declared = new Set(
    (envJson ?? [])
      .filter((entry) => appliesToAgent(entry.applies))
      .map((entry) => entry.name),
  );
  const entries = new Map<string, EnvVarSpec>();
  const keys = new Set([
    ...Object.keys(servers ?? {}),
    ...refs.map((ref) => ref.key),
  ]);
  for (const key of keys) {
    const server = servers?.[key];
    const workerVars =
      server === undefined || usesConnectionAuth(server)
        ? []
        : (server.workerVars ?? []);
    const serverEntries = new Map<string, EnvVarSpec>(
      workerVars.map((entry) => [
        entry.name,
        entry.source === "inherit"
          ? { ...entry, mcp: key, applies: "agent" }
          : { ...entry, applies: "agent" },
      ]),
    );
    for (const name of refs.find((ref) => ref.key === key)?.requiredEnv ?? []) {
      if (serverEntries.has(name)) continue;
      serverEntries.set(name, {
        source: "inherit",
        name,
        from: name,
        secret: true,
        optional: false,
        mcp: key,
        applies: "agent",
      });
    }
    for (const [name, entry] of serverEntries) {
      if (declared.has(name)) continue;
      const existing = entries.get(name);
      if (!existing) {
        entries.set(name, entry);
        continue;
      }
      if (existing.source !== "inherit" || entry.source !== "inherit") {
        if (sameSource(existing, entry)) continue;
        throw new Error(
          `MCP servers give the variable ${name} different sources; give them different names.`,
        );
      }
      const shared = { ...existing };
      delete shared.mcp;
      entries.set(name, {
        ...shared,
        secret: existing.secret || entry.secret,
        optional: existing.optional && entry.optional,
      });
    }
  }
  return [...(envJson ?? []), ...entries.values()];
}

function sameSource(a: EnvVarSpec, b: EnvVarSpec): boolean {
  if (a.source === "secret" && b.source === "secret") {
    return a.secretName === b.secretName;
  }
  if (a.source === "value" && b.source === "value") {
    return a.value === b.value && a.secret === b.secret;
  }
  return false;
}

function usesConnectionAuth(server: OpenCodeMcpServerConfig): boolean {
  return server.type !== "local" && server.auth !== undefined;
}

/** An enabled authored step MCP server authenticated by a managed connection. */
export type StepConnectionAuthEntry = {
  key: string;
  connection: ManagedConnectionName;
};

/**
 * The step's enabled MCP servers with `auth`, read from the authored entries
 * without resolving refs. Real runs authenticate these through the relay;
 * dry runs have no run's managed launch, so they skip these steps.
 */
export function stepConnectionAuthEntries(
  servers: OpenCodeMcpServers | null | undefined,
): StepConnectionAuthEntry[] {
  return Object.entries(servers ?? {}).flatMap(([key, server]) =>
    server.type !== "local" &&
    server.auth !== undefined &&
    server.disabled !== true
      ? [{ key, connection: server.auth.connection }]
      : [],
  );
}

/** Why a dry run skips a step that needs a run's managed launch. */
export function describeNotRunnableConnections(
  entries: readonly StepConnectionAuthEntry[],
): string {
  const names = [
    ...new Set(entries.map(({ connection }) => `"${connection}"`)),
  ];
  return `uses the project's ${names.join(" and ")} connection${names.length > 1 ? "s" : ""}: skipped: needs a run's managed launch`;
}

/** {@link describeNotRunnableConnections} for the step's servers, or null when it uses no managed connection. */
export function stepNotRunnableReason(
  servers: OpenCodeMcpServers | null | undefined,
): string | null {
  const entries = stepConnectionAuthEntries(servers);
  return entries.length > 0 ? describeNotRunnableConnections(entries) : null;
}

/**
 * Whether the step's MCP servers add variables to the step env: a ref
 * (its definition's `{env:X}`) or `workerVars`. A server with `auth` adds
 * none; the connection authenticates it.
 */
export function stepMcpServersAddEnv(
  servers: OpenCodeMcpServers | null | undefined,
): boolean {
  return Object.values(servers ?? {}).some(
    (server) =>
      !usesConnectionAuth(server) &&
      (server.type === "ref" || (server.workerVars?.length ?? 0) > 0),
  );
}

function hasMcpRefs(servers: OpenCodeMcpServers | null | undefined): boolean {
  return Object.values(servers ?? {}).some(
    (entry) => entry.type === "ref" && !usesConnectionAuth(entry),
  );
}

/**
 * Resolves a step's env after environment resolution, and — when the step names MCP server
 * refs — a resolver the launch calls once it has discovered the refs, adding
 * each ref's inferred variables (D3). Declarations from every server are
 * included even when no repository discovery is needed.
 */
export function planStepEnv(input: {
  envVars: readonly EnvVarSpec[] | null | undefined;
  inputJson: unknown;
  workerEnv: Readonly<Record<string, string | undefined>>;
  projectSecrets?: Readonly<Record<string, string>> | undefined;
  opencodeMcpJson: OpenCodeMcpServers | null | undefined;
}): {
  resolved: ResolvedStepEnv;
  resolveMcpEnv: ((refs: readonly McpEnvRef[]) => ResolvedStepEnv) | undefined;
} {
  const declaredCount = (input.envVars ?? []).length;
  const resolve = (envVars: readonly EnvVarSpec[]): ResolvedStepEnv => ({
    ...resolveStepEnv({
      envVars,
      inputJson: input.inputJson,
      workerEnv: input.workerEnv,
      projectSecrets: input.projectSecrets,
    }),
    mcpOnlyEnvNames: envVars.slice(declaredCount).map((entry) => entry.name),
  });
  const needsDiscovery = hasMcpRefs(input.opencodeMcpJson);
  const declared = withInferredMcpEnv(input.envVars, [], input.opencodeMcpJson);
  return {
    resolved: resolve(
      needsDiscovery
        ? declared.map((entry) =>
            entry.source === "inherit" ? { ...entry, optional: true } : entry,
          )
        : declared,
    ),
    resolveMcpEnv: needsDiscovery
      ? (refs) =>
          resolve(
            withInferredMcpEnv(input.envVars, refs, input.opencodeMcpJson),
          )
      : undefined,
  };
}

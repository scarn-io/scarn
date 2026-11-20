import type {
  OpenCodeMcpServers,
  ResolvedOpenCodeMcpServers,
} from "../../../common/contracts/opencode-mcp";
import { mergeConnectorMcpServers } from "@scarn/sdk/connectors";
import { discoverRepoAgentTools } from "../../../project/agent-tools/infra/discover-repo-agent-tools";
import type {
  McpEnvRef,
  ResolvedStepEnv,
} from "../application/resolve-step-env";
import { logWork } from "../application/work-logger";
import type { RegisterLaunchServers } from "../contracts/managed-launch-types";
import {
  type ResolvedConnectionAuth,
  resolveStepMcpServers,
} from "./mcp-server-ref-resolver";

/** A step's MCP servers with every ref resolved, plus what env resolution needs from each ref. */
export type StepMcpServerPlan = {
  servers: ResolvedOpenCodeMcpServers | null;
  refs: McpEnvRef[];
  /** The managed relay capabilities in {@link servers}, for the log masker. */
  secretValues: string[];
};

/**
 * Builds a launch's MCP servers from the step's entries and the servers
 * discovered in `workspacePath` (the host-side checkout): refs resolved,
 * every other discovered server disabled. Returns each ref's `requiredEnv`
 * for env resolution (D3). Logs each resolved
 * ref by key, source and type, plus the disabled and skipped server names —
 * never a definition, which can carry secrets.
 *
 * The environment's `connectors` join under their ids (decision 9); their
 * `{env:NAME}` placeholders read the step env, which the environment's
 * `vars` already cover.
 *
 * An enabled entry with `auth: { connection }` (logged by key, connection,
 * source and the names of the dropped headers) calls `registerManagedLaunch`
 * once with every such entry's resolved URL and every other enabled remote's,
 * which the server checks against the project's connections, and points at
 * the relay entry it returns (see `pointAtManagedRelay`).
 *
 * Throws `McpServerRefNotFoundError`, `McpConnectionAuthNotRemoteError`,
 * whatever `registerManagedLaunch` throws (`ManagedConnectionNotReadyError`,
 * `McpConnectionAuthRejectedError`),
 * or `ConnectorMcpCollision` when a step `mcps` key reuses a connector id;
 * the caller lets each propagate so the launch fails before OpenCode starts.
 */
export async function planStepMcpServers(input: {
  servers: OpenCodeMcpServers | null | undefined;
  connectors?: readonly string[] | undefined;
  workspacePath: string;
  sessionId: string;
  registerManagedLaunch?: RegisterLaunchServers | undefined;
}): Promise<StepMcpServerPlan> {
  const tools = await discoverRepoAgentTools(input.workspacePath);
  const {
    servers,
    resolvedRefs,
    disabledServers,
    connectionAuth,
    remotesWithoutAuth,
  } = resolveStepMcpServers({
    servers: input.servers,
    tools,
  });
  for (const ref of resolvedRefs) {
    logWork("runtime", "Resolved MCP server ref", {
      sessionId: input.sessionId,
      key: ref.key,
      lookupName: ref.lookupName,
      source: ref.source,
      type: ref.type,
      inlineSecretsRemoved: ref.inlineSecrets.map(
        ({ field, key }) => `${field}.${key}`,
      ),
    });
  }
  if (disabledServers.length > 0 || tools.skipped.length > 0) {
    logWork("runtime", "Repository MCP servers not used by this step", {
      sessionId: input.sessionId,
      disabled: disabledServers,
      skipped: tools.skipped
        .filter((entry) => entry.kind === "server")
        .map(({ source, name, reason }) => ({ source, name, reason })),
    });
  }
  for (const auth of connectionAuth) {
    logWork("runtime", "MCP server uses a managed connection", {
      sessionId: input.sessionId,
      key: auth.key,
      connection: auth.connection,
      source: auth.source,
      droppedHeaders: auth.droppedHeaders,
      droppedOAuth: auth.droppedOAuth,
    });
  }
  const secretValues =
    connectionAuth.length > 0 && servers
      ? await pointAtManagedRelay({
          servers,
          connectionAuth,
          remotesWithoutAuth,
          registerManagedLaunch: input.registerManagedLaunch,
          sessionId: input.sessionId,
        })
      : [];
  const connectors = input.connectors ?? [];
  if (connectors.length > 0) {
    logWork("runtime", "Connectors added to the step's MCP servers", {
      sessionId: input.sessionId,
      connectors,
    });
  }
  return {
    servers: mergeConnectorMcpServers(
      connectors,
      servers,
      Object.keys(input.servers ?? {}),
    ),
    refs: resolvedRefs.map(({ key, requiredEnv }) => ({ key, requiredEnv })),
    secretValues,
  };
}

const urlsByKey = (entries: readonly { key: string; url: string }[]) =>
  Object.fromEntries(entries.map(({ key, url }) => [key, { url }]));

/**
 * Registers the managed launch with the resolved URLs and replaces each
 * connection-auth server, in place, with its relay entry: the relay URL and
 * the capability as a bearer header, with OpenCode's own OAuth off. Returns
 * the capabilities for the log masker.
 */
async function pointAtManagedRelay(input: {
  servers: ResolvedOpenCodeMcpServers;
  connectionAuth: readonly ResolvedConnectionAuth[];
  remotesWithoutAuth: readonly { key: string; url: string }[];
  registerManagedLaunch: RegisterLaunchServers | undefined;
  sessionId: string;
}): Promise<string[]> {
  const keys = input.connectionAuth.map(({ key }) => key);
  if (!input.registerManagedLaunch) {
    throw new Error(
      `MCP servers ${keys.map((key) => `"${key}"`).join(", ")} use a managed connection, which this launch can't register.`,
    );
  }
  const entries = await input.registerManagedLaunch({
    entries: urlsByKey(input.connectionAuth),
    remotesWithoutAuth: urlsByKey(input.remotesWithoutAuth),
  });
  const secretValues: string[] = [];
  for (const key of keys) {
    const entry = entries[key];
    const server = input.servers[key];
    if (!entry || server?.type !== "remote") {
      throw new Error(
        `The managed launch registration returned no relay entry for MCP server "${key}".`,
      );
    }
    input.servers[key] = {
      ...server,
      url: entry.relayUrl,
      headers: { Authorization: `Bearer ${entry.capability}` },
      oauth: false,
    };
    secretValues.push(entry.capability);
  }
  logWork("runtime", "Managed connection MCP servers point at the relay", {
    sessionId: input.sessionId,
    keys,
  });
  return secretValues;
}

export type StepMcpLaunch = {
  servers: ResolvedOpenCodeMcpServers | null;
  stepEnv: Readonly<Record<string, string>> | undefined;
  /**
   * Secret values of variables inferred from the refs and the managed relay
   * capabilities, for the log masker.
   */
  secretValues: string[];
};

/**
 * Resolves the step env again with each ref's inferred variables when the
 * step names refs (`resolveMcpEnv` is set). Without `resolveMcpEnv` the
 * caller's `stepEnv` passes through untouched. Throws `MissingStepEnvError`
 * for any missing required variable.
 */
export function applyStepMcpEnv(input: {
  plan: StepMcpServerPlan;
  stepEnv: Readonly<Record<string, string>> | undefined;
  resolveMcpEnv: ((refs: readonly McpEnvRef[]) => ResolvedStepEnv) | undefined;
}): StepMcpLaunch {
  if (input.resolveMcpEnv === undefined) {
    return {
      servers: input.plan.servers,
      stepEnv: input.stepEnv,
      secretValues: input.plan.secretValues,
    };
  }
  const resolved = input.resolveMcpEnv(input.plan.refs);
  return {
    servers: input.plan.servers,
    stepEnv: resolved.stepEnv,
    secretValues: [...resolved.secretValues, ...input.plan.secretValues],
  };
}

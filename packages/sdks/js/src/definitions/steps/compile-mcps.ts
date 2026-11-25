import type { EnvVarSpecInput, EnvVarsInput } from "../../env-vars";
import type { HealthChecksInput } from "../../health-checks";
import {
  containsBasicPlaceholder,
  type OpenCodeMcpServerConfig,
  type OpenCodeMcpServers,
} from "../../opencode-mcp";
import { isMcpHandle, resolveMcpChecks, type McpHandle } from "./define-mcp";
import { inferredMcpEnv } from "./mcp-server-config";
import {
  connectorMcpCollisionMessage,
  findConnectorMcpCollisions,
} from "../../connectors";
import { isEnvironmentHandle } from "../../push/code-step-lookup";

/**
 * Compiles a step's `mcps` (`defineMcp` handles keyed by the step's server
 * key) into wire fields, carrying each server's worker vars independently
 * from the step environment and combining health checks.
 */

type WorkerVar = EnvVarSpecInput & { applies: "agent" };

export type CompiledMcps = {
  opencodeMcpJson: OpenCodeMcpServers;
  healthChecks: HealthChecksInput;
};

export type StepMcpFields = {
  opencodeMcpJson: OpenCodeMcpServers | null;
  healthChecksJson: HealthChecksInput | null;
  envJson: EnvVarsInput | null;
};

function compileServer(
  key: string,
  handle: McpHandle,
): OpenCodeMcpServerConfig {
  const workerVars = compileEnv(key, handle);
  const metadata = workerVars.length > 0 ? { workerVars } : {};
  switch (handle.type) {
    case "ref":
      return {
        type: "ref",
        ...(handle.name !== key ? { name: handle.name } : {}),
        ...structuredClone(handle.server),
        ...metadata,
      };
    case "local":
      return { type: "local", ...structuredClone(handle.server), ...metadata };
    case "remote":
      return { type: "remote", ...structuredClone(handle.server), ...metadata };
  }
}

function compileChecks(key: string, handle: McpHandle): HealthChecksInput {
  return resolveMcpChecks(handle)
    .filter((resolved) => resolved.enabled)
    .map(({ name, check }) => ({
      kind: "tool" as const,
      mcp: key,
      name: `${key}.${name}`,
      tool: check.tool,
      ...(check.args !== undefined ? { args: check.args } : {}),
      ...(check.timeoutSeconds !== undefined
        ? { timeoutSeconds: check.timeoutSeconds }
        : {}),
      serialGroup: check.serialGroup ?? key,
      severity: check.severity ?? "required",
    }));
}

/**
 * MCP variables always apply to the agent: MCP servers run inside it.
 * `vars` come first, as declared. An
 * inline server's `{env:VAR}` names are required unless listed in
 * `optionalEnv`, the same as the worker infers them for a `ref`. A server
 * with `auth` gets none: the connection authenticates it.
 */
function compileEnv(key: string, handle: McpHandle): WorkerVar[] {
  if (handle.type !== "local" && handle.server.auth !== undefined) return [];
  const entry = (name: string, optional: boolean): WorkerVar => ({
    source: "inherit",
    name,
    from: name,
    secret: true,
    optional,
    mcp: key,
    applies: "agent",
  });
  const declared = handle.vars.map(
    (spec): WorkerVar =>
      spec.source === "inherit"
        ? { ...spec, mcp: key, applies: "agent" }
        : { ...spec, applies: "agent" },
  );
  const listed = new Set([
    ...handle.env,
    ...handle.optionalEnv,
    ...declared.map((spec) => spec.name),
  ]);
  const inferred = inferredMcpEnv(handle).filter((name) => !listed.has(name));
  return [
    ...declared,
    ...handle.env.map((name) => entry(name, false)),
    ...inferred.map((name) => entry(name, false)),
    ...handle.optionalEnv.map((name) => entry(name, true)),
  ];
}

/** Throws when a value under `mcps` is not a `defineMcp` handle. */
export function compileMcps(
  mcps: Readonly<Record<string, McpHandle>>,
  stepKey: string,
): CompiledMcps {
  const compiled: CompiledMcps = {
    opencodeMcpJson: {},
    healthChecks: [],
  };
  for (const [key, handle] of Object.entries(mcps)) {
    if (!isMcpHandle(handle)) {
      throw new Error(
        `Step "${stepKey}" mcps.${key}: expected a handle from defineMcp().`,
      );
    }
    compiled.opencodeMcpJson[key] = compileServer(key, handle);
    compiled.healthChecks.push(...compileChecks(key, handle));
  }
  return compiled;
}

/**
 * Throws when a step `mcps` key reuses a connector id of the step's
 * environment handle. A name-only environment is checked at publish and
 * startup instead.
 */
export function assertNoConnectorMcpCollisions(
  stepKey: string,
  // eslint-disable-next-line local/no-unknown-parameter-type
  environment: unknown,
  mcps: Readonly<Record<string, McpHandle>> | undefined,
): void {
  if (!isEnvironmentHandle(environment) || mcps === undefined) return;
  const collisions = findConnectorMcpCollisions(
    environment.content.connectors ?? [],
    Object.keys(mcps),
  );
  if (collisions.length === 0) return;
  throw new Error(
    `Step "${stepKey}" environment "${environment.name}": ${connectorMcpCollisionMessage(collisions)}`,
  );
}

/**
 * Throws when an agent step's `mcps` holds a server whose headers use
 * `{basic:…}`: OpenCode can't read it, and the worker only substitutes it
 * for the MCP calls it makes itself (code and MCP tool steps).
 */
export function assertNoAgentBasicPlaceholders(
  stepKey: string,
  mcps: Readonly<Record<string, McpHandle>> | undefined,
): void {
  for (const [key, handle] of Object.entries(mcps ?? {})) {
    if (!isMcpHandle(handle) || handle.type !== "remote") continue;
    if (!containsBasicPlaceholder(handle.server.headers)) continue;
    throw new Error(
      `Step "${stepKey}" mcps.${key}: headers use {basic:USER_VAR:PASS_VAR}, which an agent's OpenCode can't read. Use the server from a code step or an MCP tool step.`,
    );
  }
}

function nonEmpty<T>(items: T[]): T[] | null {
  return items.length > 0 ? items : null;
}

/**
 * Merges compiled `mcps` into the step's own fields: MCP checks run before the
 * step's own. Variable declarations stay on each server until worker resolution.
 */
export function mergeStepMcps(
  stepKey: string,
  input: {
    mcps: Readonly<Record<string, McpHandle>> | undefined;
    healthChecks: HealthChecksInput | null | undefined;
    envJson: EnvVarsInput | null;
  },
): StepMcpFields {
  if (!input.mcps || Object.keys(input.mcps).length === 0) {
    return {
      opencodeMcpJson: null,
      healthChecksJson: input.healthChecks ?? null,
      envJson: input.envJson,
    };
  }
  const compiled = compileMcps(input.mcps, stepKey);
  return {
    opencodeMcpJson: compiled.opencodeMcpJson,
    healthChecksJson: nonEmpty([
      ...compiled.healthChecks,
      ...(input.healthChecks ?? []),
    ]),
    envJson: input.envJson,
  };
}

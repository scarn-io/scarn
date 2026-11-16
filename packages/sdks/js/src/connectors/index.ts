/**
 * Connectors: the catalog, the environment's `connectors` field, and the
 * rules shared by the SDK, core and the worker (required vars, merging into a
 * step's MCP servers, and the step `mcps` collision rule).
 */
import { z } from "zod";
import type { EnvVarSpecInput } from "../env-vars";
import type { ResolvedOpenCodeMcpServers } from "../opencode-mcp";
import { CONNECTOR_CATALOG, isConnectorId } from "./catalog";

export * from "./catalog";

export const connectorIdsSchema = z
  .array(z.string())
  .superRefine((ids, ctx) => {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      if (!isConnectorId(id)) {
        ctx.addIssue({
          code: "custom",
          path: [index],
          message: `unknown connector "${id}"; known connectors: ${Object.keys(CONNECTOR_CATALOG).join(", ")}`,
        });
      } else if (seen.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: [index],
          message: `connector "${id}" is listed more than once`,
        });
      }
      seen.add(id);
    });
  });

export type ConnectorVarsMissingEntry = {
  connector: string;
  vars: string[];
};

export class ConnectorVarsMissing extends Error {
  readonly kind = "ConnectorVarsMissing";
  readonly code = "SCARN_CONNECTOR_VARS_MISSING";

  /** `environment` is `environment <name> v<N>` for a named environment. */
  constructor(
    readonly environment: string | undefined,
    readonly missing: readonly ConnectorVarsMissingEntry[],
  ) {
    super(
      `The ${environment ?? "environment reference"} is missing variables its connectors need: ${missing
        .map(({ connector, vars }) => `${connector} needs ${vars.join(", ")}`)
        .join("; ")}. Add them to the environment's vars.`,
    );
  }
}

/**
 * For each connector, the required variables the environment does not give
 * the agent. A setup-only var does not count: the MCP server runs in the
 * agent.
 */
export function findMissingConnectorVars(
  connectors: readonly string[],
  envVars: readonly Pick<EnvVarSpecInput, "name" | "applies">[],
): ConnectorVarsMissingEntry[] {
  const provided = new Set(
    envVars
      .filter((entry) => entry.applies !== "setup")
      .map((entry) => entry.name),
  );
  return connectors.flatMap((connector) => {
    const vars = (CONNECTOR_CATALOG[connector]?.requiredVars ?? [])
      .map((variable) => variable.name)
      .filter((name) => !provided.has(name));
    return vars.length > 0 ? [{ connector, vars }] : [];
  });
}

/** Step `mcps` keys that reuse a connector id (decision 9). */
export function findConnectorMcpCollisions(
  connectors: readonly string[],
  stepMcpKeys: Iterable<string>,
): string[] {
  const ids = new Set(connectors);
  return [...stepMcpKeys].filter((key) => ids.has(key)).sort();
}

export function connectorMcpCollisionMessage(
  collisions: readonly string[],
): string {
  return `step mcps ${collisions.map((key) => `"${key}"`).join(", ")} collide with the environment's connectors; rename the step's MCP server or drop the connector`;
}

export class ConnectorMcpCollision extends Error {
  readonly kind = "ConnectorMcpCollision";
  readonly code = "SCARN_ENVIRONMENT_INVALID";

  constructor(readonly collisions: readonly string[]) {
    super(connectorMcpCollisionMessage(collisions));
  }
}

/**
 * The step's MCP servers plus each connector's catalog config under its id.
 * Throws `ConnectorMcpCollision` when one of `stepMcpKeys` (the step's own
 * `mcps` keys; default: every key of `servers`) reuses a connector id. Other
 * entries under a connector id, such as a disabled repository server, are
 * replaced.
 */
export function mergeConnectorMcpServers(
  connectors: readonly string[],
  servers: ResolvedOpenCodeMcpServers | null,
  stepMcpKeys: Iterable<string> = Object.keys(servers ?? {}),
): ResolvedOpenCodeMcpServers | null {
  if (connectors.length === 0) return servers;
  const collisions = findConnectorMcpCollisions(connectors, stepMcpKeys);
  if (collisions.length > 0) throw new ConnectorMcpCollision(collisions);
  const merged: ResolvedOpenCodeMcpServers = { ...servers };
  for (const id of connectors) {
    const connector = CONNECTOR_CATALOG[id];
    if (connector === undefined) throw new Error(`Unknown connector "${id}"`);
    merged[id] = structuredClone(connector.mcp);
  }
  return merged;
}

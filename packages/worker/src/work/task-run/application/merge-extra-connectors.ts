/**
 * Decision 5 on the worker: a Task's extra connectors join its environment
 * before variable resolution. Each extra's id is added to `connectors` (so the
 * MCP merge and the startup gate cover it) and each of its vars becomes a
 * `secret` var, resolved like any other: the worker's `.scarn/.env` first,
 * then Scarn's project secrets. A var the environment already gives the agent
 * keeps the environment's value. The server guarantees extra ids collide with
 * neither the environment's connectors nor the step's `mcps`.
 */
import { appliesToAgent } from "@scarn/sdk/env-vars";
import type { EnvironmentDefinition } from "@scarn/sdk/resolve-environment";
import type { ExtraConnector } from "../contracts/task-run-contracts";

export function mergeExtraConnectors(
  definition: EnvironmentDefinition,
  extraConnectors: readonly ExtraConnector[],
): EnvironmentDefinition {
  if (extraConnectors.length === 0) return definition;
  const provided = new Set(
    definition.envVars
      .filter((entry) => appliesToAgent(entry.applies))
      .map((entry) => entry.name),
  );
  const envVars = [...definition.envVars];
  for (const extra of extraConnectors) {
    for (const [name, { secret }] of Object.entries(extra.vars)) {
      if (provided.has(name)) continue;
      provided.add(name);
      envVars.push({
        name,
        source: "secret",
        secretName: secret,
        applies: "agent",
      });
    }
  }
  return {
    ...definition,
    envVars,
    connectors: [
      ...definition.connectors,
      ...extraConnectors.map((extra) => extra.connectorId),
    ],
  };
}

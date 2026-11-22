import { findMissingConnectorVars, getConnector } from "@scarn/sdk/connectors";
import type { EnvironmentContent } from "@scarn/core/common/contracts/environment";
import { CoreValidationError } from "@scarn/core/lib/errors";
import type { ExtraConnector } from "./task-environment-selection";

/**
 * Decision 5: each extra must be a catalog connector the effective
 * environment and the step's `mcps` don't already have, and each of its
 * `requiredVars` the environment doesn't provide must name a project secret.
 * Returns the first problem as a 422, or `null` when every extra fits.
 * Checked when the Task is created and again at startup against the pinned
 * version.
 */
export const extraConnectorsFit = (
  extraConnectors: readonly ExtraConnector[],
  environment: Pick<EnvironmentContent, "connectors" | "vars">,
  stepMcpKeys: readonly string[],
): CoreValidationError | null => {
  const present = new Set([...(environment.connectors ?? []), ...stepMcpKeys]);
  for (const extra of extraConnectors) {
    if (getConnector(extra.connectorId) === undefined) {
      return new CoreValidationError(
        `Unknown connector "${extra.connectorId}"`,
        "CONNECTOR_NOT_FOUND",
        { connectorId: extra.connectorId },
      );
    }
    if (present.has(extra.connectorId)) {
      return new CoreValidationError(
        `Connector "${extra.connectorId}" is already part of this Task's environment or step`,
        "CONNECTOR_ALREADY_PRESENT",
        { connectorId: extra.connectorId },
      );
    }
    present.add(extra.connectorId);
    const [needed] = findMissingConnectorVars(
      [extra.connectorId],
      environment.vars ?? [],
    );
    const missing = (needed?.vars ?? []).filter(
      (name) => extra.vars[name] === undefined,
    );
    if (missing.length > 0) {
      return new CoreValidationError(
        `Connector "${extra.connectorId}" needs ${missing.join(", ")}; name a project secret for each`,
        "CONNECTOR_VAR_MISSING",
        { connectorId: extra.connectorId, vars: missing },
      );
    }
  }
  return null;
};

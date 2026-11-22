import {
  findHostSetupVar,
  hostSetupVarMessage,
} from "@scarn/core/common/contracts/environment";
import { CoreValidationError } from "@scarn/core/lib/errors";
import type { TaskExecutionConfigContent } from "../contracts/task-execution-config-stored";

const listOrNone = (keys: readonly string[]) =>
  keys.length > 0 ? keys.map((key) => `"${key}"`).join(", ") : "(none)";

/**
 * The D14 rules that span a config's fields. An env var's or health check's
 * `mcp` must name a server key of any type.
 */
export const assertTaskExecutionConfigCrossFieldRules = ({
  environment,
  mcp,
  healthChecks,
}: Pick<
  TaskExecutionConfigContent,
  "environment" | "mcp" | "healthChecks"
>): void => {
  const env = environment?.kind === "inline" ? environment.vars : undefined;
  if (environment?.kind === "inline") {
    const setupVar = findHostSetupVar(environment);
    if (setupVar) {
      throw new CoreValidationError(
        hostSetupVarMessage(setupVar),
        "TASK_EXECUTION_CONFIG_ENV_SETUP_WITHOUT_WORKSPACE",
      );
    }
  }

  const serverKeys = Object.keys(mcp ?? {}).sort();

  for (const entry of env ?? []) {
    if (entry.source !== "inherit" || entry.mcp === undefined) continue;
    if (!serverKeys.includes(entry.mcp)) {
      throw new CoreValidationError(
        `env var "${entry.name}" belongs to MCP server "${entry.mcp}", but no server has that key. Declared servers: ${listOrNone(serverKeys)}`,
        "TASK_EXECUTION_CONFIG_ENV_MCP_UNKNOWN",
      );
    }
    if (entry.applies !== "agent") {
      throw new CoreValidationError(
        `env var "${entry.name}" belongs to MCP server "${entry.mcp}" and must apply to 'agent' (MCP servers run inside the agent), got '${entry.applies}'`,
        "TASK_EXECUTION_CONFIG_ENV_MCP_APPLIES_NOT_ALLOWED",
      );
    }
  }

  for (const [index, check] of (healthChecks ?? []).entries()) {
    if (check.kind !== "tool" || check.mcp === undefined) continue;
    if (!serverKeys.includes(check.mcp)) {
      throw new CoreValidationError(
        `health check #${String(index + 1)} names MCP server "${check.mcp}", but no server has that key. Declared servers: ${listOrNone(serverKeys)}`,
        "TASK_EXECUTION_CONFIG_HEALTH_CHECK_MCP_UNKNOWN",
      );
    }
  }
};

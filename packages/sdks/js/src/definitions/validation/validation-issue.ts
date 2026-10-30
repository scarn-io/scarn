// `DefinitionValidationIssue` + tiny message-formatting helpers shared by
// every check file.

export type DefinitionValidationIssue = {
  readonly check:
    | "health-check-mcp-server"
    | "health-check-double-qualified"
    | "env-var"
    | "env-var-mcp"
    | "env-var-applies"
    | "runtime"
    | "repo"
    | "artifact-field"
    | "artifact-marker";
  /**
   * Whether this issue blocks a push. Only `assertValidDefinitionSpecs`
   * treats the tiers differently: it blocks a push on `"error"` alone.
   */
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
};

/** Formats a path list for an error message, capped so it stays readable. */
export function listPaths(paths: readonly string[], limit = 24): string {
  if (paths.length === 0) return "";
  if (paths.length <= limit) return paths.join(", ");
  return `${paths.slice(0, limit).join(", ")}, … (${String(paths.length - limit)} more)`;
}

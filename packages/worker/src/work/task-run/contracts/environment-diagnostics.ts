import type { ResolvedEnvironment } from "@scarn/sdk/environment";
import type { EnvVarSpec } from "@scarn/sdk/env-vars";

/** Value-free provenance for a resolved launch; never persist the full environment. */
export type EnvironmentDiagnostics = {
  source: ResolvedEnvironment["source"];
  name: string | null;
  /** The named environment's pinned version; null for inline or repo default. */
  definitionVersion: { name: string; version: number } | null;
  checkoutCommit: string;
  runtime: ResolvedEnvironment["runtime"];
  branch: string;
  /** Null for a chat run, which is parked on a pinned commit. */
  branches: LaunchBranchDiagnostics | null;
  vars: { name: string; source: EnvironmentVarSource }[];
  connectors: { id: string; source: ConnectorSource }[];
};

/** `extra` marks a connector the Task added on top of its environment's (decision 5). */
export type ConnectorSource = "environment" | "extra";

/**
 * Which rule picked the base branch (ADR 0010). `server` is the server's
 * `baseWorkBranch`: the Task's continued branch or the previous step's work
 * branch, which the worker can't tell apart.
 */
export type BaseBranchSource =
  "server" | "step" | "worker" | "project" | "remoteDefault";

export type LaunchBranchDiagnostics = {
  /** The step's `baseBranch` template, unrendered. */
  template: string | null;
  /** The branch checked out. */
  base: string;
  source: BaseBranchSource;
  /** The branch the run commits to; null when it commits nothing. */
  work: string | null;
  workMode: "create" | "base" | null;
};

/**
 * Where a var's value came from. A `secret` var is `secret:worker` when the
 * worker's `.scarn/.env` holds its secret name, else `secret:scarn`.
 */
export type EnvironmentVarSource =
  "value" | "worker" | "secret:worker" | "secret:scarn";

function varSource(
  entry: EnvVarSpec,
  localEnvVars: Readonly<Record<string, string>>,
): EnvironmentVarSource {
  if (entry.source === "value") return "value";
  if (entry.source === "inherit") return "worker";
  return localEnvVars[entry.secretName] === undefined
    ? "secret:scarn"
    : "secret:worker";
}

export function buildEnvironmentDiagnostics(
  environment: ResolvedEnvironment,
  provenance: {
    definitionVersion: { name: string; version: number } | null;
    checkoutCommit: string;
    branch: string;
    branches: LaunchBranchDiagnostics | null;
  },
  effectiveVars: readonly EnvVarSpec[] = environment.envVars,
  localEnvVars: Readonly<Record<string, string>> = {},
  extraConnectorIds: readonly string[] = [],
): EnvironmentDiagnostics {
  const extras = new Set(extraConnectorIds);
  return {
    source: environment.source,
    name: environment.name ?? null,
    ...provenance,
    runtime: environment.runtime,
    vars: effectiveVars.map((entry) => ({
      name: entry.name,
      source: varSource(entry, localEnvVars),
    })),
    connectors: environment.connectors.map((id) => ({
      id,
      source: extras.has(id) ? "extra" : "environment",
    })),
  };
}

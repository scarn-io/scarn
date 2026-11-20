import type {
  EnvironmentRef,
  ResolvedEnvironment,
  ResolvedEnvironmentRefInput,
} from "@scarn/sdk/environment";
import type { HealthCheck } from "@scarn/sdk/health-checks";
import type { OpenCodeMcpServers } from "../../../common/contracts/opencode-mcp";
import {
  stepConnectionAuthEntries,
  type StepConnectionAuthEntry,
} from "./resolve-step-env";
import { partitionManagedMcpHealthChecks } from "./probe-managed-mcp-connections";
import type { HealthCheckReport } from "./run-health-checks";

/**
 * Plans how the post-push run-offer gate runs every step's health checks
 * with as few launches as possible: one per environment. Null remains the
 * repository default; a named environment groups by `name@version` (its
 * latest version, fetched before planning); inline refs compare as whole
 * objects, including runtime and variables. Resolution happens independently
 * after cloning each planned launch.
 *
 * Two steps with the same reference still need separate launches when their
 * rendered base branches differ (each launch checks out one), or when the
 * same `mcpServers` key has different definitions.
 * Merging those silently would test a server one step never gets. Such a step
 * goes into the next launch of that runtime that has no conflict, or a new one.
 *
 * Steps with no declared checks are not launched at all; code steps never
 * declare any. Managed auth startup is probed server-side; only its tool
 * checks are skipped, while ordinary checks still share launches.
 * Pure, so the grouping is unit-tested without a launch.
 */

export type HealthCheckStep = {
  stepDefinitionId: string;
  key: string;
  name: string;
  /** The step's ref, with a named environment's latest version fetched. */
  environment: ResolvedEnvironmentRefInput;
  opencodeMcpJson: OpenCodeMcpServers | null;
  healthChecksJson: HealthCheck[] | null;
  /** The step's `baseBranch` rendered from `env` tokens alone; null when it has none or that was not possible. */
  baseWorkBranch?: string | null | undefined;
  /** Why the step's `baseBranch` was not rendered (see `renderEnvOnlyBaseBranch`). */
  baseBranchNote?: string | null | undefined;
};

export type HealthCheckRuntime = ResolvedEnvironmentRefInput;

export type PlannedHealthCheckLaunch = {
  runtime: HealthCheckRuntime;
  /** Checked out after clone; null falls back to the configured or remote default branch. */
  baseWorkBranch: string | null;
  /** In pipeline order; every one declares at least one check. */
  steps: HealthCheckStep[];
  opencodeMcpJson: OpenCodeMcpServers;
};

export type ManagedHealthCheckStep = {
  step: HealthCheckStep;
  entries: StepConnectionAuthEntry[];
  skippedChecks: HealthCheckReport[];
};

export type HealthCheckLaunchPlan = {
  launches: PlannedHealthCheckLaunch[];
  /** Steps that declare no checks, so nothing runs for them. */
  stepsWithoutChecks: HealthCheckStep[];
  /** Enabled managed servers require a server-side startup probe, even without checks. */
  managedSteps: ManagedHealthCheckStep[];
};

export function resolveHealthCheckRuntime(
  step: HealthCheckStep,
): HealthCheckRuntime {
  return step.environment;
}

/** Named environments group by `name@version`; inline ones by canonical content. */
function launchKey(runtime: HealthCheckRuntime): string {
  if (runtime?.kind !== "named") return canonicalJson(runtime);
  return "notFound" in runtime
    ? `named:${runtime.name}:not-found`
    : `named:${runtime.name}@${String(runtime.version)}`;
}

export function describeHealthCheckRuntime(
  runtime: EnvironmentRef | HealthCheckRuntime,
  resolved?: ResolvedEnvironment,
): string {
  if (resolved) {
    const description = describeHealthCheckRuntime({
      kind: "inline",
      runtime: resolved.runtime,
    });
    if (runtime?.kind === "named") {
      return `environment ${runtime.name} (${description})`;
    }
    return runtime === null || !runtime.runtime
      ? `repository default (${description})`
      : description;
  }
  if (runtime === null) return "repository default";
  if (runtime.kind === "named") return `environment ${runtime.name}`;
  const selected = runtime.runtime;
  if (!selected) return "repository default";
  switch (selected.kind) {
    case "host":
      return "host";
    case "managed":
      return `managed runtime ${selected.id}`;
    case "devcontainer":
      return selected.config === undefined
        ? "project devcontainer"
        : `devcontainer ${selected.config}`;
  }
}

/** JSON with object keys sorted, so equal definitions compare equal. */
// eslint-disable-next-line local/no-unknown-parameter-type -- serializes already-parsed definitions, not a real input boundary
function canonicalJson(value: unknown): string {
  // eslint-disable-next-line local/no-unknown-parameter-type -- JSON.stringify replacer receives arbitrary nested values
  return JSON.stringify(value, (_key, nested: unknown) =>
    nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      : nested,
  );
}

/** Entries of `incoming` whose key is already in `existing` with a different value. */
function conflictsByKey<T>(
  existing: ReadonlyMap<string, T>,
  incoming: ReadonlyMap<string, T>,
): boolean {
  for (const [key, value] of incoming) {
    const current = existing.get(key);
    if (
      current !== undefined &&
      canonicalJson(current) !== canonicalJson(value)
    ) {
      return true;
    }
  }
  return false;
}

const mcpEntries = (step: HealthCheckStep) =>
  new Map(Object.entries(step.opencodeMcpJson ?? {}));

type LaunchBuilder = {
  runtimeKey: string;
  runtime: HealthCheckRuntime;
  baseWorkBranch: string | null;
  steps: HealthCheckStep[];
  mcp: Map<string, OpenCodeMcpServers[string]>;
};

function fits(builder: LaunchBuilder, step: HealthCheckStep): boolean {
  return !conflictsByKey(builder.mcp, mcpEntries(step));
}

function addStep(builder: LaunchBuilder, step: HealthCheckStep): void {
  builder.steps.push(step);
  for (const [key, value] of mcpEntries(step)) builder.mcp.set(key, value);
}

/** Group `steps` (in pipeline order) into the launches that run their checks. */
export function planHealthCheckLaunches(
  steps: readonly HealthCheckStep[],
): HealthCheckLaunchPlan {
  const builders: LaunchBuilder[] = [];
  const stepsWithoutChecks: HealthCheckStep[] = [];
  const managedSteps: ManagedHealthCheckStep[] = [];

  for (const authoredStep of steps) {
    const entries = stepConnectionAuthEntries(authoredStep.opencodeMcpJson);
    const { runnableChecks, skippedChecks } = partitionManagedMcpHealthChecks({
      entries,
      healthChecks: authoredStep.healthChecksJson ?? [],
    });
    if (entries.length > 0) {
      managedSteps.push({ step: authoredStep, entries, skippedChecks });
    }
    const step = {
      ...authoredStep,
      healthChecksJson: runnableChecks,
      opencodeMcpJson: Object.fromEntries(
        Object.entries(authoredStep.opencodeMcpJson ?? {}).filter(
          ([, server]) => server.type === "local" || server.auth === undefined,
        ),
      ),
    };
    if (step.healthChecksJson.length === 0) {
      if (entries.length === 0) stepsWithoutChecks.push(authoredStep);
      continue;
    }
    const runtime = resolveHealthCheckRuntime(step);
    const runtimeKey = launchKey(runtime);
    const baseWorkBranch = step.baseWorkBranch ?? null;
    let builder = builders.find(
      (candidate) =>
        candidate.runtimeKey === runtimeKey &&
        candidate.baseWorkBranch === baseWorkBranch &&
        fits(candidate, step),
    );
    if (!builder) {
      builder = {
        runtimeKey,
        runtime,
        baseWorkBranch,
        steps: [],
        mcp: new Map(),
      };
      builders.push(builder);
    }
    addStep(builder, step);
  }

  return {
    launches: builders.map((builder) => ({
      runtime: builder.runtime,
      baseWorkBranch: builder.baseWorkBranch,
      steps: builder.steps,
      opencodeMcpJson: Object.fromEntries(builder.mcp),
    })),
    stepsWithoutChecks,
    managedSteps,
  };
}

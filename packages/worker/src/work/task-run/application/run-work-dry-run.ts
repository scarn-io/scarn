import type { DestinationStream } from "pino";
import type { createScarnClient } from "@scarn/sdk";
import type {
  EnvironmentRef,
  ResolvedEnvironment,
} from "@scarn/sdk/environment";
import type { HealthCheck } from "@scarn/sdk/health-checks";
import { resolveRepoConfig, type RepoConfig } from "@scarn/sdk/repo-config";
import { createUuidV7, parseUuidV7 } from "../../../common/contracts/uuid-v7";
import type { OpenCodeMcpServers } from "../../../common/contracts/opencode-mcp";
import { ConfigurationError } from "../../../lib/errors";
import { createLogger } from "@scarn/observability/logging/host";
import { resolveScarnBaseUrl } from "../../../auth/session/infra/auth-config";
import { loadAuthenticatedSession } from "../../../auth/session/application/load-authenticated-session";
import { createAuthenticatedScarnClient } from "../../../auth/session/infra/authenticated-scarn-client";
import { DirectProviderAccessResolver } from "../infra/provider-access/direct-provider-access-resolver";
import { SafeProviderAccessResolver } from "../infra/provider-access/safe-provider-access-resolver";
import { logWork, logWorkError } from "./work-logger";
import { noopReporter, type WorkReporter } from "../contracts/work-reporter";
import { buildFakeAiProviderOverride, FakeAiServer } from "../infra/fake-ai";
import {
  buildDryRunOrchestrator,
  DRY_RUN_CLAIM_TOKEN,
} from "./run-work-dry-run-orchestrators";
import type { McpHandshakeReport } from "./run-work-dry-run-health-checks";
import { runInDryRunEnvironment } from "./dry-run-environment";
import { runHealthChecks, type HealthCheckReport } from "./run-health-checks";
import { computeDryRunOk } from "./compute-dry-run-ok";
import { dryRunBaseBranch, environmentRefVars } from "./render-base-branch";
import { planDryRunStepEnv } from "./plan-step-env-with-secrets";
import type { DryRunSecretReport } from "./resolve-secret-env";
import type { LaunchedRuntimeOrchestrator } from "../contracts/process-project-work-types";
import { describeHealthCheckRuntime } from "./plan-pipeline-health-check-launches";
import {
  managedOnlyWorkDryRunReport,
  prepareWorkDryRunHealthChecks,
} from "./prepare-work-dry-run-health-checks";
import {
  createLatestEnvironmentFetcher,
  resolveStepEnvironmentRef,
  type DryRunLaunchStep,
} from "./resolve-step-environment-ref";

export type { McpHandshakeReport } from "./run-work-dry-run-health-checks";
export type {
  HealthCheckOutcome,
  HealthCheckReport,
} from "./run-health-checks";

export type WorkDryRunScope =
  | {
      kind: "step";
      stepDefinitionId: string;
      stepDefinitionKey: string;
      stepDefinitionName: string;
      runtimeKind: "host" | "devcontainer" | "managed" | null;
      devcontainerConfigPath: string | null;
      environmentSource?: ResolvedEnvironment["source"];
      environmentName?: string;
    }
  | { kind: "global-only" };

export type WorkDryRunReport = {
  /** See {@link computeDryRunOk} — health, handshakes, and health check outcomes combined. */
  ok: boolean;
  scope: WorkDryRunScope;
  runtime?: string;
  workspacePath: string | null;
  runtimeContainerId: string | null;
  agentBaseUrl: string | null;
  /** True when `--keep` preserved the container/workspace instead of tearing it down. */
  kept: boolean;
  containerHealth: { status: string; healthy: boolean } | null;
  opencodeHealth: { healthy: boolean; detail?: string | undefined } | null;
  providerCredentials: { ok: boolean; detail: string };
  /** Handshake status only — whether each server's declared health checks (if any) passed lives in {@link WorkDryRunReport.healthChecks}. */
  mcpServers: McpHandshakeReport[];
  /**
   * The step's declared health checks (#121), run via the shared runner
   * (`runHealthChecks`, #119) and reported flat — a check on a plugin or
   * standalone tool has no MCP server to nest under, so this is a top-level
   * array covering every declared check regardless of source. Empty when the
   * step declares none; there is no fallback verification in that case.
   */
  healthChecks: HealthCheckReport[];
  /**
   * Each `secret` var's source: `worker` when `.scarn/.env` holds it, else
   * `scarn` (a real run requests it from Scarn; a dry run never fetches it).
   */
  secrets: DryRunSecretReport[];
  /**
   * Set when the step's `baseBranch` could not be rendered without a run
   * (see `renderEnvOnlyBaseBranch`), so the dry run checked out the
   * configured or remote default branch instead.
   */
  baseBranchNote?: string | undefined;
  /** Set when runtime launch failed; server-side managed startup reports still apply. */
  launchError?: string | undefined;
  /** Reserved for steps that cannot be rehearsed. Managed startup is probed server-side. */
  notRunnable?: string | undefined;
};

export type WorkDryRunOptions = {
  projectId: string;
  baseUrl?: string | undefined;
  /** Fetch this step definition's real `opencodeMcpJson`. */
  stepDefinitionId?: string | undefined;
  /**
   * Skip step-specific MCP injection; test whatever MCP servers are already
   * configured (e.g. the user's synced global `opencode.json`). Callers should
   * set this when the project has no step definitions yet, or the user opted
   * out of picking one.
   */
  globalOnly?: boolean | undefined;
  /** Preserve the container/workspace after the report instead of tearing down. */
  keep?: boolean | undefined;
  dest?: DestinationStream | undefined;
  /** Env vars read from .scarn/.env in the user's local project directory. */
  localEnvVars?: Record<string, string> | undefined;
  reporter?: WorkReporter | undefined;
};

export type StepDefinitionForDryRun = {
  id: string;
  key: string;
  name: string;
  environment: EnvironmentRef;
  repo: RepoConfig;
  resultSchemaJson: Record<string, unknown> | null;
  opencodeMcpJson: OpenCodeMcpServers | null;
  healthChecksJson: HealthCheck[] | null;
};

/** A global-only dry run has no step, so it commits nothing: read-only. */
const DRY_RUN_GLOBAL_REPO: RepoConfig = resolveRepoConfig({
  mode: "readOnly",
  gitCredentials: "none",
});

export function buildWorkDryRunRuntimeInput(
  stepDefinition: DryRunLaunchStep | null,
): Pick<
  Parameters<LaunchedRuntimeOrchestrator["launch"]>[0],
  "environment" | "repo"
> {
  return {
    environment: stepDefinition?.environment ?? null,
    repo: stepDefinition?.repo ?? DRY_RUN_GLOBAL_REPO,
  };
}

export function buildWorkDryRunScope(
  step: StepDefinitionForDryRun | null,
  resolved?: ResolvedEnvironment,
): WorkDryRunScope {
  if (!step) return { kind: "global-only" };
  const runtime =
    resolved?.runtime ??
    (step.environment?.kind === "inline"
      ? step.environment.runtime
      : undefined);
  return {
    kind: "step",
    stepDefinitionId: step.id,
    stepDefinitionKey: step.key,
    stepDefinitionName: step.name,
    runtimeKind: runtime?.kind ?? null,
    devcontainerConfigPath:
      runtime?.kind === "devcontainer" ? (runtime.config ?? null) : null,
    environmentSource:
      resolved?.source ??
      (step.environment === null ? "repo-default" : step.environment.kind),
    ...(step.environment?.kind === "named"
      ? { environmentName: step.environment.name }
      : {}),
  };
}

export async function fetchProjectGitUrl(
  client: ReturnType<typeof createScarnClient>,
  projectId: string,
): Promise<string> {
  const result = await client.projects.getProject({
    path: { projectId },
  });
  const gitUrl = (result.data as { gitUrl?: string } | undefined)?.gitUrl;
  if (!gitUrl) {
    throw new ConfigurationError(
      `Could not resolve the git URL for project ${projectId}.`,
    );
  }
  return gitUrl;
}

export async function fetchStepDefinition(
  client: ReturnType<typeof createScarnClient>,
  stepDefinitionId: string,
): Promise<StepDefinitionForDryRun> {
  const result = await client.stepDefinitions.getStepDefinition({
    path: { stepDefinitionId },
  });
  const data = result.data as StepDefinitionForDryRun | undefined;
  if (!data) {
    throw new ConfigurationError(
      `Step definition ${stepDefinitionId} was not found.`,
    );
  }
  return {
    id: data.id,
    key: data.key,
    name: data.name,
    environment: data.environment,
    repo: data.repo,
    resultSchemaJson: data.resultSchemaJson,
    opencodeMcpJson: data.opencodeMcpJson,
    healthChecksJson: data.healthChecksJson,
  };
}

/**
 * Environment-only rehearsal of the production launch path, for `work
 * --dry-run`: brings up the exact same devcontainer + in-container OpenCode
 * process a real task run would (with that step's real MCP servers
 * injected, when scoped to one), then reports container health, OpenCode
 * health, provider-credential status, and per-MCP-server health — without
 * claiming a task, sending any prompt, or producing findings.
 *
 * Missing provider credentials are reported as a line item rather than
 * aborting the run (see {@link SafeProviderAccessResolver}), since diagnosing
 * exactly that is a stated use case (onboarding, before credentials exist).
 */
export async function runWorkDryRun(
  options: WorkDryRunOptions,
): Promise<WorkDryRunReport> {
  if (!options.stepDefinitionId && !options.globalOnly) {
    throw new ConfigurationError(
      "runWorkDryRun requires either stepDefinitionId or globalOnly.",
    );
  }

  const baseUrl = resolveScarnBaseUrl(options.baseUrl);
  const authenticated = await loadAuthenticatedSession(baseUrl);
  if (!authenticated) {
    throw new ConfigurationError(`Not signed in to ${baseUrl}.`);
  }
  const requestedByUserId = parseUuidV7(authenticated.session.user.id);
  const projectId = parseUuidV7(options.projectId);

  const client = createAuthenticatedScarnClient(
    baseUrl,
    authenticated.profile.accessToken,
  );
  const gitUrl = await fetchProjectGitUrl(client, options.projectId);

  const stepDefinition = options.stepDefinitionId
    ? await fetchStepDefinition(client, options.stepDefinitionId)
    : null;
  const launchStep = stepDefinition && {
    environment: await resolveStepEnvironmentRef(
      stepDefinition.environment,
      createLatestEnvironmentFetcher(client, options.projectId),
    ),
    repo: stepDefinition.repo,
  };

  const scope = buildWorkDryRunScope(stepDefinition);
  const { baseWorkBranch, baseBranchNote } = dryRunBaseBranch({
    template: stepDefinition?.repo.baseBranch ?? null,
    envVars: launchStep ? environmentRefVars(launchStep.environment) : [],
    workerEnv: { ...process.env, ...options.localEnvVars },
  });
  const note = baseBranchNote ? { baseBranchNote } : {};

  const reporter = options.reporter ?? noopReporter;
  const checks = await prepareWorkDryRunHealthChecks({
    client,
    projectId: options.projectId,
    opencodeMcpJson: stepDefinition?.opencodeMcpJson,
    healthChecks: stepDefinition?.healthChecksJson ?? [],
  });
  if (!checks.needsRuntime) {
    return managedOnlyWorkDryRunReport({
      scope,
      ...checks.mergeReports({ mcpServers: [], healthChecks: [] }),
      note,
    });
  }
  const logger = createLogger(
    {
      name: "@scarn/worker",
      level: process.env["SCARN_LOG_LEVEL"] ?? "info",
    },
    options.dest,
  ).child({ scope: "work-dry-run" });

  const sessionId = createUuidV7();
  // Synthetic — never sent to the server. Used only to correlate reporter
  // events and to satisfy the launch contract's `currentExecutionInfo`.
  const taskRunId = sessionId;

  const safeProviderAccessResolver = new SafeProviderAccessResolver(
    new DirectProviderAccessResolver({ logger }),
  );
  const orchestrator = buildDryRunOrchestrator(
    logger,
    options.localEnvVars ?? {},
    safeProviderAccessResolver,
  );

  logWork("dry-run", "Starting work dry run", {
    projectId: options.projectId,
    scope,
    keep: options.keep ?? false,
  });
  reporter.event({ type: "task:starting", taskRunId });

  // Started unconditionally (rather than only when the step declares
  // `healthChecks`) because the fake provider must be baked into the agent's
  // launch-time config, before any forced tool call can run. Shared across
  // every declared health check below and stopped once, regardless of
  // outcome.
  const fakeAiServer = new FakeAiServer();
  await fakeAiServer.start();

  const keep = options.keep ?? false;
  let secrets: DryRunSecretReport[] = [];
  try {
    const outcome = await runInDryRunEnvironment({
      orchestrator,
      keep,
      launchInput: {
        ...buildWorkDryRunRuntimeInput(launchStep),
        startAgent: true,
        sessionId,
        projectId,
        requestedByUserId,
        gitUrl,
        claimToken: DRY_RUN_CLAIM_TOKEN,
        stepBaseBranch: baseWorkBranch,
        localEnvVars: options.localEnvVars,
        // No stepKey: skips work-branch creation, so a dry run never pushes or
        // even creates a `scarn/...` branch.
        stepKey: undefined,
        opencodeMcpJson: checks.opencodeMcpJson,
        currentExecutionInfo: {
          taskRunId,
          resultSchemaJson: stepDefinition?.resultSchemaJson ?? null,
          turnsRemaining: null,
        },
        reporter,
        taskRunId,
        resolveFakeAiProviderOverride: (environment) =>
          buildFakeAiProviderOverride({
            fakeAiServer,
            isNoWorkspace: environment.runtime.kind === "host",
          }),
        resolveEnvironmentEnv: (environment) => {
          const dryRun = planDryRunStepEnv({
            envVars: environment.envVars,
            inputJson: null,
            workerEnv: { ...process.env, ...options.localEnvVars },
            localEnvVars: options.localEnvVars,
            opencodeMcpJson: checks.opencodeMcpJson,
          });
          secrets = dryRun.secrets;
          return Promise.resolve(dryRun.plan);
        },
      },
      // Same runner the real-execution gate uses (`runHealthChecks`, #119),
      // with its declaration-order, abort-required-then-skip-the-rest
      // semantics unchanged; the probe already ran the MCP startup gate. Dry
      // run's different policy (#121) sits above this call: a failing check
      // never throws or cuts the dry run short, and every check gets a
      // reported outcome.
      onLaunched: () => {
        reporter.event({ type: "task:runtime-ready", taskRunId });
      },
      run: (server) =>
        runHealthChecks({
          server,
          healthChecks: checks.runnableChecks,
          fakeAiServer,
        }),
    });

    const providerCredentials = safeProviderAccessResolver.lastError
      ? { ok: false, detail: safeProviderAccessResolver.lastError.message }
      : { ok: true, detail: "resolved" };

    if (outcome.kind === "launch-failed") {
      const reason = outcome.reason;
      logWorkError("dry-run", "Dry run environment failed to launch", {
        projectId: options.projectId,
        scope,
        error: reason,
      });
      reporter.event({ type: "task:failed", taskRunId, reason });
      return {
        ok: false,
        scope,
        workspacePath: null,
        runtimeContainerId: null,
        agentBaseUrl: null,
        kept: false,
        containerHealth: null,
        opencodeHealth: null,
        providerCredentials,
        ...checks.mergeReports({ mcpServers: [], healthChecks: [] }),
        secrets,
        ...note,
        launchError: reason,
      };
    }

    const { health } = outcome;
    const { mcpServers, healthChecks } = checks.mergeReports({
      mcpServers: health.mcpServers,
      healthChecks: outcome.result,
    });

    const ok = computeDryRunOk({
      containerHealthy: health.containerHealth?.healthy,
      opencodeHealthy: health.opencodeHealth.healthy,
      mcpServers,
      healthChecks,
    });

    reporter.event(
      ok
        ? { type: "task:succeeded", taskRunId }
        : {
            type: "task:failed",
            taskRunId,
            reason: "One or more health checks failed — see the report above.",
          },
    );

    logWork(
      "dry-run",
      keep
        ? "Dry run environment preserved (--keep)"
        : "Dry run environment cleaned up",
      {
        projectId: options.projectId,
        workspacePath: outcome.workspacePath,
        runtimeContainerId: outcome.runtimeContainerId,
        agentBaseUrl: outcome.agentBaseUrl,
      },
    );

    return {
      ok,
      scope: buildWorkDryRunScope(stepDefinition, outcome.resolvedEnvironment),
      runtime: describeHealthCheckRuntime(
        stepDefinition?.environment ?? null,
        outcome.resolvedEnvironment,
      ),
      workspacePath: outcome.workspacePath,
      runtimeContainerId: outcome.runtimeContainerId,
      agentBaseUrl: outcome.agentBaseUrl,
      kept: keep,
      containerHealth: health.containerHealth,
      opencodeHealth: health.opencodeHealth,
      providerCredentials,
      mcpServers,
      healthChecks,
      secrets,
      ...note,
    };
  } finally {
    // eslint-disable-next-line local/no-unknown-parameter-type -- narrows a caught value, not a real input boundary
    await fakeAiServer.stop().catch((error: unknown) => {
      logWorkError("dry-run", "Failed to stop the shared fake AI server", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

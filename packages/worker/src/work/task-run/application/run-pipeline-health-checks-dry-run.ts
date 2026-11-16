import type { DestinationStream } from "pino";
import { createScarnClient } from "@scarn/sdk";
import { resolveRepoConfig, type RepoConfig } from "@scarn/sdk/repo-config";
import type { ResolvedEnvironment } from "@scarn/sdk/environment";
import { createLogger } from "@scarn/observability/logging/host";
import { createUuidV7, parseUuidV7 } from "../../../common/contracts/uuid-v7";
import { ConfigurationError } from "../../../lib/errors";
import { resolveScarnBaseUrl } from "../../../auth/session/infra/auth-config";
import { loadAuthenticatedSession } from "../../../auth/session/application/load-authenticated-session";
import { DirectProviderAccessResolver } from "../infra/provider-access/direct-provider-access-resolver";
import { SafeProviderAccessResolver } from "../infra/provider-access/safe-provider-access-resolver";
import type { LaunchedRuntimeOrchestrator } from "../contracts/process-project-work-types";
import { buildFakeAiProviderOverride, FakeAiServer } from "../infra/fake-ai";
import {
  buildDryRunOrchestrator,
  DRY_RUN_CLAIM_TOKEN,
} from "./run-work-dry-run-orchestrators";
import {
  runInDryRunEnvironment,
  type DryRunEnvironmentHealth,
} from "./dry-run-environment";
import { runHealthChecks, type HealthCheckReport } from "./run-health-checks";
import { planDryRunStepEnv } from "./plan-step-env-with-secrets";
import {
  buildAuthHeaders,
  fetchProjectGitUrl,
  fetchStepDefinition,
} from "./run-work-dry-run";
import {
  describeHealthCheckRuntime,
  planHealthCheckLaunches,
  type HealthCheckRuntime,
  type HealthCheckStep,
  type PlannedHealthCheckLaunch,
} from "./plan-pipeline-health-check-launches";
import {
  computePipelineHealthGateOk,
  type StepHealthCheckReport,
} from "./pipeline-health-check-report";
import {
  createLatestEnvironmentFetcher,
  resolveStepEnvironmentRef,
} from "./resolve-step-environment-ref";
import { logWork, logWorkError } from "./work-logger";
import { dryRunBaseBranch, environmentRefVars } from "./render-base-branch";
import { mcpStartupGateServers } from "./mcp-startup-gate";
import {
  listPinnedStepDefinitionIds,
  readActivePipelineVersion,
} from "./pipeline-version-steps";

/**
 * The post-push run-offer gate's dry run: every step of a pushed pipeline has
 * its declared health checks run, in one launch per distinct runtime (see
 * `plan-pipeline-health-check-launches.ts`), and the result is reported per
 * step (see `pipeline-health-check-report.ts`).
 *
 * Each step's checks run as their own `runHealthChecks` call on the shared
 * launch, so a `required` failure aborts only the rest of that step's checks,
 * never another step's. Launches run one after another, each torn down before
 * the next starts, so a pipeline never has two containers up at once.
 */

export type PipelineHealthDryRunReport = {
  /** See `computePipelineHealthGateOk`: false only for blocking findings. */
  ok: boolean;
  pipelineDefinitionId: string;
  /** How many environments were launched. */
  launchCount: number;
  /** Steps that declare checks, in pipeline order. */
  steps: StepHealthCheckReport[];
  /** Steps that declare none (code steps always), so nothing ran for them. */
  stepsWithoutChecks: Array<{ stepKey: string; stepName: string }>;
};

/** What running one planned launch produced. */
export type HealthCheckLaunchOutcome =
  | { kind: "launch-failed"; reason: string }
  | {
      kind: "ran";
      resolvedEnvironment: ResolvedEnvironment;
      health: DryRunEnvironmentHealth;
      /** Keyed by `stepDefinitionId`. */
      healthChecksByStep: ReadonlyMap<string, HealthCheckReport[]>;
    };

export type RunHealthCheckLaunch = (
  launch: PlannedHealthCheckLaunch,
) => Promise<HealthCheckLaunchOutcome>;

export function buildPipelineHealthCheckRuntimeInput(
  runtime: HealthCheckRuntime,
): Pick<Parameters<LaunchedRuntimeOrchestrator["launch"]>[0], "environment"> {
  return { environment: runtime };
}

function environmentProblems(health: DryRunEnvironmentHealth): string[] {
  const problems: string[] = [];
  if (health.containerHealth && !health.containerHealth.healthy) {
    problems.push(`container ${health.containerHealth.status}`);
  }
  if (!health.opencodeHealth.healthy) {
    problems.push(
      `OpenCode unhealthy${health.opencodeHealth.detail ? ` (${health.opencodeHealth.detail})` : ""}`,
    );
  }
  return problems;
}

function toStepReport(
  step: HealthCheckStep,
  runtime: string,
  outcome: HealthCheckLaunchOutcome,
): StepHealthCheckReport {
  const base = {
    stepDefinitionId: step.stepDefinitionId,
    stepKey: step.key,
    stepName: step.name,
    runtime,
    baseBranchNote: step.baseBranchNote ?? null,
  };
  if (outcome.kind === "launch-failed") {
    return {
      ...base,
      launchError: outcome.reason,
      environmentProblems: [],
      mcpServers: [],
      healthChecks: [],
    };
  }
  const declared = new Set(
    mcpStartupGateServers({
      stepMcpServerKeys: Object.keys(step.opencodeMcpJson ?? {}),
      connectors: outcome.resolvedEnvironment.connectors,
    }),
  );
  return {
    ...base,
    launchError: null,
    environmentProblems: environmentProblems(outcome.health),
    mcpServers: outcome.health.mcpServers.filter((server) =>
      declared.has(server.name),
    ),
    healthChecks: outcome.healthChecksByStep.get(step.stepDefinitionId) ?? [],
  };
}

/**
 * Plan the launches for `steps` (in pipeline order), run each through
 * `runLaunch` in turn, and report per step. The I/O-free core of
 * {@link runPipelineHealthChecksDryRun}: `runLaunch` is the seam.
 */
export async function runPipelineHealthCheckLaunches(input: {
  pipelineDefinitionId: string;
  steps: readonly HealthCheckStep[];
  runLaunch: RunHealthCheckLaunch;
}): Promise<PipelineHealthDryRunReport> {
  const plan = planHealthCheckLaunches(input.steps);
  const reportByStep = new Map<string, StepHealthCheckReport>();

  for (const launch of plan.launches) {
    // A launch that throws after coming up (a probe or runner error) is
    // still torn down by `runInDryRunEnvironment`; here it only costs its
    // own steps, not the launches after it.
    let outcome: HealthCheckLaunchOutcome;
    try {
      outcome = await input.runLaunch(launch);
    } catch (error) {
      outcome = { kind: "launch-failed", reason: errorMessage(error) };
    }
    const runtime = describeHealthCheckRuntime(
      launch.runtime,
      outcome.kind === "ran" ? outcome.resolvedEnvironment : undefined,
    );
    for (const step of launch.steps) {
      reportByStep.set(
        step.stepDefinitionId,
        toStepReport(step, runtime, outcome),
      );
    }
  }

  const steps = input.steps.flatMap((step) => {
    const report = reportByStep.get(step.stepDefinitionId);
    return report ? [report] : [];
  });
  return {
    ok: computePipelineHealthGateOk(steps),
    pipelineDefinitionId: input.pipelineDefinitionId,
    launchCount: plan.launches.length,
    steps,
    stepsWithoutChecks: plan.stepsWithoutChecks.map((step) => ({
      stepKey: step.key,
      stepName: step.name,
    })),
  };
}

export type PipelineHealthChecksDryRunOptions = {
  projectId: string;
  pipelineDefinitionId: string;
  baseUrl?: string | undefined;
  dest?: DestinationStream | undefined;
  /** Env vars read from `.scarn/.env` in the user's local project directory. */
  localEnvVars?: Record<string, string> | undefined;
};

/** A dry run has no step key, so it never commits, on any runtime. */
const repoForLaunch = (): RepoConfig =>
  resolveRepoConfig({ mode: "readOnly", gitCredentials: "none" });

// eslint-disable-next-line local/no-unknown-parameter-type -- narrows a caught value, not a real input boundary
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fetch `pipelineDefinitionId`'s steps and run every one's health checks, one
 * launch per distinct runtime. Never throws for an unhealthy environment or a
 * failing check — those are in the report, as is a named environment the
 * project does not have — only for an unreadable pipeline, step, or
 * environment.
 */
export async function runPipelineHealthChecksDryRun(
  options: PipelineHealthChecksDryRunOptions,
): Promise<PipelineHealthDryRunReport> {
  const baseUrl = resolveScarnBaseUrl(options.baseUrl);
  const authenticated = await loadAuthenticatedSession(baseUrl);
  if (!authenticated) {
    throw new ConfigurationError(`Not signed in to ${baseUrl}.`);
  }
  const headers = buildAuthHeaders(authenticated.profile.accessToken);
  const requestedByUserId = parseUuidV7(authenticated.session.user.id);
  const projectId = parseUuidV7(options.projectId);
  const client = createScarnClient(baseUrl);

  const pipeline = await client.pipelineDefinitions.getPipelineDefinition({
    path: { pipelineDefinitionId: options.pipelineDefinitionId },
    headers,
  });
  const activeVersion = readActivePipelineVersion(
    options.pipelineDefinitionId,
    pipeline.data,
  );
  const stepDefinitions = await Promise.all(
    listPinnedStepDefinitionIds(activeVersion).map((id) =>
      fetchStepDefinition(client, headers, id),
    ),
  );
  const fetchLatestEnvironment = createLatestEnvironmentFetcher(
    client,
    headers,
    options.projectId,
  );
  const localEnvVars = options.localEnvVars ?? {};
  const steps: HealthCheckStep[] = await Promise.all(
    stepDefinitions.map(async (step) => {
      const environment = await resolveStepEnvironmentRef(
        step.environment,
        fetchLatestEnvironment,
      );
      return {
        stepDefinitionId: step.id,
        key: step.key,
        name: step.name,
        environment,
        opencodeMcpJson: step.opencodeMcpJson,
        healthChecksJson: step.healthChecksJson,
        ...dryRunBaseBranch({
          template: step.repo.baseBranch,
          envVars: environmentRefVars(environment),
          workerEnv: { ...process.env, ...localEnvVars },
        }),
      };
    }),
  );

  const logger = createLogger(
    {
      name: "@scarn/worker",
      level: process.env["SCARN_LOG_LEVEL"] ?? "info",
    },
    options.dest,
  ).child({ scope: "pipeline-health-dry-run" });
  const providerAccessResolver = new SafeProviderAccessResolver(
    new DirectProviderAccessResolver({ logger }),
  );
  const orchestrator = buildDryRunOrchestrator(
    logger,
    localEnvVars,
    providerAccessResolver,
  );

  const gitUrl = await fetchProjectGitUrl(client, headers, options.projectId);

  // One fake provider for every launch: it has to be baked into each agent's
  // launch-time config before any forced tool call can run.
  const fakeAiServer = new FakeAiServer();
  await fakeAiServer.start();

  const runLaunch: RunHealthCheckLaunch = async (launch) => {
    const runtime = describeHealthCheckRuntime(launch.runtime);
    const taskRunId = createUuidV7();
    logWork("dry-run", "Launching for pipeline health checks", {
      pipelineDefinitionId: options.pipelineDefinitionId,
      runtime,
      steps: launch.steps.map((step) => step.key),
    });
    const outcome = await runInDryRunEnvironment({
      orchestrator,
      keep: false,
      launchInput: {
        ...buildPipelineHealthCheckRuntimeInput(launch.runtime),
        startAgent: true,
        sessionId: taskRunId,
        projectId,
        requestedByUserId,
        gitUrl,
        claimToken: DRY_RUN_CLAIM_TOKEN,
        stepBaseBranch: launch.baseWorkBranch,
        localEnvVars,
        stepKey: undefined,
        opencodeMcpJson: launch.opencodeMcpJson,
        currentExecutionInfo: {
          taskRunId,
          resultSchemaJson: null,
          turnsRemaining: null,
        },
        taskRunId,
        resolveFakeAiProviderOverride: (environment) =>
          buildFakeAiProviderOverride({
            fakeAiServer,
            isNoWorkspace: environment.runtime.kind === "host",
          }),
        resolveEnvironmentEnv: (environment) =>
          Promise.resolve(
            planDryRunStepEnv({
              envVars: environment.envVars,
              inputJson: null,
              workerEnv: { ...process.env, ...localEnvVars },
              localEnvVars,
              opencodeMcpJson: launch.opencodeMcpJson,
            }).plan,
          ),
        repo: repoForLaunch(),
      },
      run: async (server) => {
        const healthChecksByStep = new Map<string, HealthCheckReport[]>();
        for (const step of launch.steps) {
          healthChecksByStep.set(
            step.stepDefinitionId,
            await runHealthChecks({
              server,
              healthChecks: step.healthChecksJson ?? [],
              fakeAiServer,
            }),
          );
        }
        return healthChecksByStep;
      },
    });
    if (outcome.kind === "launch-failed") {
      logWorkError("dry-run", "Pipeline health-check launch failed", {
        pipelineDefinitionId: options.pipelineDefinitionId,
        runtime,
        error: outcome.reason,
      });
      return outcome;
    }
    return {
      kind: "ran",
      resolvedEnvironment: outcome.resolvedEnvironment,
      health: outcome.health,
      healthChecksByStep: outcome.result,
    };
  };

  try {
    return await runPipelineHealthCheckLaunches({
      pipelineDefinitionId: options.pipelineDefinitionId,
      steps,
      runLaunch,
    });
  } finally {
    // eslint-disable-next-line local/no-unknown-parameter-type -- narrows a caught value, not a real input boundary
    await fakeAiServer.stop().catch((error: unknown) => {
      logWorkError("dry-run", "Failed to stop the shared fake AI server", {
        error: errorMessage(error),
      });
    });
  }
}

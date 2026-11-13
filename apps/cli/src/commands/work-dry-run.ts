/**
 * `scarn work --dry-run`: rehearses the environment a real task would launch,
 * in this process, and reports its health instead of running work.
 */
import { AnalyticsEvents } from "@scarn/observability/analytics/events";
import {
  readLocalEnvVars,
  resolveScarnBaseUrl,
  resolveSourceBranch,
} from "@scarn/worker";
import {
  createCliLogger,
  createTransport,
  ensureLogDir,
  resolveLogFilePath,
} from "../lib/logger";
import { createReporter } from "../lib/reporter";
import { createRecordingReporter } from "../lib/reporter-record";
import { runWorkDryRunCommand } from "../lib/dry-run-command";
import {
  NO_PROJECT_MESSAGE,
  pickProjectRef,
  PROJECT_ACTIONS,
  resolveCliProjectRef,
} from "../lib/resolve-project-ref";
import {
  captureMilestone,
  shutdownTelemetry,
  syncIdentityFromDisk,
} from "../lib/telemetry";

export type WorkDryRunOptions = {
  /** The project as `owner/slug`; defaults to `"project"` in `.scarn/scarn.jsonc`. */
  project?: string | undefined;
  baseUrl?: string | undefined;
  /** Keep the rehearsed runtime instead of tearing it down after the report. */
  preserveRuntimeOnComplete?: boolean | undefined;
  /**
   * Override the branch the rehearsal checks out (instead of resolving and
   * verifying the current local branch). An override only needs to exist on
   * `origin`.
   */
  sourceBranch?: string | undefined;
  /** Fetch this step definition's real MCP servers to test. */
  stepId?: string | undefined;
  /**
   * Skip step-specific MCP injection and test whatever MCP servers are
   * already configured. Implied automatically when the project has no step
   * definitions yet.
   */
  globalOnly?: boolean | undefined;
  /**
   * Resolve this **pipeline** id to its ordered step list and test its first
   * step. Wins outright over `stepId`/`globalOnly`.
   */
  pipelineId?: string | undefined;
};

/** Runs the dry run and throws when it finds unhealthy checks. */
export async function runWorkDryRun(
  arguments_: WorkDryRunOptions,
): Promise<void> {
  await ensureLogDir();
  const logFilePath = resolveLogFilePath();
  // Initialize the transport (and open the log file) before anything else logs.
  createTransport();

  const logger = createCliLogger("work-command");
  const recordReportPath = process.env["SCARN_RECORD_REPORT"];
  const reporter = recordReportPath
    ? createRecordingReporter(createReporter({ logFilePath }), recordReportPath)
    : createReporter({ logFilePath });
  const baseUrl = resolveScarnBaseUrl(arguments_.baseUrl);
  const projectRef = await pickProjectRef(arguments_.project);
  const preserveRuntimeOnComplete =
    arguments_.preserveRuntimeOnComplete ?? false;
  const globalOnly = arguments_.globalOnly ?? false;

  syncIdentityFromDisk(baseUrl);

  if (!projectRef) {
    reporter.error(NO_PROJECT_MESSAGE);
    logger.error(NO_PROJECT_MESSAGE);
    await shutdownTelemetry();
    process.exit(1);
  }

  // Resolve (and verify) the branch the same way a real run does, before
  // anything else. Fails fast rather than silently falling back to the
  // repo's default branch.
  let sourceBranch: string | null;
  try {
    const result = await resolveSourceBranch({
      cwd: process.cwd(),
      override: arguments_.sourceBranch,
    });
    sourceBranch = result.branch;
    if (result.warning) {
      reporter.warn(result.warning);
      logger.warn({ branch: sourceBranch }, result.warning);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reporter.error(message);
    logger.error({ err: error }, "Failed to resolve the source branch");
    await shutdownTelemetry();
    process.exit(1);
  }

  reporter.start("Scarn worker (dry run)");
  if (sourceBranch) {
    reporter.info(`Using source branch: ${sourceBranch}`);
  }

  let projectId: string;
  try {
    ({ id: projectId } = await resolveCliProjectRef({
      baseUrl,
      ref: projectRef,
      action: PROJECT_ACTIONS.work,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reporter.error(message);
    logger.error(
      { err: error, project: projectRef },
      "Failed to resolve the project",
    );
    await shutdownTelemetry();
    process.exit(1);
  }

  logger.info(
    {
      project: projectRef,
      projectId,
      baseUrl,
      preserveRuntimeOnComplete,
      stepId: arguments_.stepId,
      globalOnly,
      pipelineId: arguments_.pipelineId,
      sourceBranch,
    },
    "Starting work dry run",
  );

  const localEnvVars = await readLocalEnvVars(process.cwd());
  logger.info(
    {
      varCount: Object.keys(localEnvVars).length,
      varNames: Object.keys(localEnvVars),
    },
    "Loaded .scarn/.env",
  );

  try {
    const { ok } = await runWorkDryRunCommand({
      projectId,
      baseUrl,
      stepId: arguments_.stepId,
      globalOnly,
      pipelineId: arguments_.pipelineId,
      // "Preserve the runtime instead of tearing it down" means the same
      // thing for a dry run as for a real run.
      keep: preserveRuntimeOnComplete,
      localEnvVars,
      reporter,
      sourceBranch,
    });

    if (!ok) {
      throw new Error("Dry run found unhealthy checks — see the report above.");
    }

    reporter.finish("Dry run healthy");
    captureMilestone(AnalyticsEvents.CliDryRunPassed, { via: "work" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reporter.error(message);
    reporter.finish("Dry run found problems");
    logger.error({ err: error }, "Work dry run failed");
    throw error;
  }
}

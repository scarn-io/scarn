import type { DestinationStream } from "pino";
import { createLogger } from "@scarn/observability/logging/host";
import type { WorkReporter } from "../contracts/process-project-work-types";
import { SqliteLocalRuntimeSessionStore } from "../infra/sqlite-local-runtime-session-store";
import { DefaultLocalProjectRuntimeEnvironmentOrchestrator } from "../infra/local-project-runtime-environment";
import { DefaultLocalNoWorkspaceRuntimeEnvironmentOrchestrator } from "../infra/local-noworkspace-runtime-environment";
import { DefaultOpencodeStepRunner } from "../infra/opencode-step-runner";
import { createTaskPlaneWorkerClient } from "../infra/worker-api-client";
import type { ProjectWorkHostDeps } from "./project-work-setup";

/**
 * The production dependencies of a project loop: the real API client, the
 * sqlite run tracker, the local runtime orchestrators and OpenCode runner,
 * and a pino logger writing to `dest`.
 */
export function createDefaultProjectWorkDeps(
  dest?: DestinationStream,
  reporter?: WorkReporter,
): ProjectWorkHostDeps {
  const logger = createLogger(
    {
      name: "@scarn/worker",
      level: process.env["SCARN_LOG_LEVEL"] ?? "info",
    },
    dest,
  );
  const workLogger = logger.child({ scope: "work" });
  return {
    createWorkerClient: createTaskPlaneWorkerClient,
    createRunTracker: () => new SqliteLocalRuntimeSessionStore(),
    runtimeEnvironmentOrchestrator:
      new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
        logger.child({ scope: "runtime-environment-orchestrator" }),
      ),
    noWorkspaceRuntimeEnvironmentOrchestrator:
      new DefaultLocalNoWorkspaceRuntimeEnvironmentOrchestrator(
        logger.child({ scope: "noworkspace-runtime-environment-orchestrator" }),
      ),
    agentRunner: new DefaultOpencodeStepRunner(),
    sleep: (milliseconds, signal) =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, milliseconds);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
          },
          { once: true },
        );
      }),
    logger: {
      debug: (scope, message, details) => {
        workLogger.debug({ ...details, workScope: scope }, message);
      },
      log: (scope, message, details) => {
        workLogger.info({ ...details, workScope: scope }, message);
      },
      error: (scope, message, details) => {
        workLogger.error({ ...details, workScope: scope }, message);
      },
    },
    reporter,
  };
}

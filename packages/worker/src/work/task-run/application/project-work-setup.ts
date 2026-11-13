import { hostname } from "node:os";
import type { DestinationStream } from "pino";
import { parseUuidV7, type UuidV7 } from "../../../common/contracts/uuid-v7";
import type { ArtifactStore } from "../../../artifacts/artifact-store/domain/artifact-store";
import { resolveArtifactStores } from "../../../artifacts/artifact-store/infra/resolve-artifact-stores";
import { resolveScarnBaseUrl } from "../../../auth/session/infra/auth-config";
import type { SlotPort } from "../../worker-host/contracts/slot-port";
import type {
  ProcessProjectWorkDeps as ProjectWorkCoreDeps,
  ProcessProjectWorkInput,
  ProjectWorkLogger,
  TaskAgentRunner,
  TaskRunTracker,
  TaskRuntimeEnvironmentOrchestrator,
  TaskRunWorkerClient,
  WorkReporter,
} from "../contracts/process-project-work-types";
import type { TaskPlaneWorkerClientOptions } from "../infra/worker-api-client";
import {
  createWorkSignalClient,
  type WorkSignalClient,
  type WorkSignalClientOptions,
} from "../infra/work-signal-client";
import type { RunRegistry } from "./run-registry";

const DEFAULT_WORK_CONCURRENCY = 1;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_POLL_INTERVAL_MS = 600_000;
const DEFAULT_CONNECTED_MAX_POLL_INTERVAL_MS = 3_600_000;
const DEFAULT_LEASE_DURATION_SECONDS = 30;

export type ProjectWorkOptions = {
  projectId: string;
  baseUrl?: string | undefined;
  batchSize?: number | undefined;
  concurrency?: number | undefined;
  pollIntervalMs?: number | undefined;
  maxPollIntervalMs?: number | undefined;
  /** Idle backoff ceiling while the push wake-up socket is connected (ms). */
  connectedMaxPollIntervalMs?: number | undefined;
  leaseDurationSeconds?: number | undefined;
  workerId?: string | undefined;
  /** A fixed work-item filter; see {@link readWorkItemId} for one that changes. */
  workItemId?: string | undefined;
  /** See `ProcessProjectWorkInput.readWorkItemId`; wins over `workItemId`. */
  readWorkItemId?: (() => string | undefined) | undefined;
  preserveRuntimeOnComplete?: boolean | undefined;
  once?: boolean | undefined;
  /** Fail-fast cap on waiting for the agent session to start (ms). */
  sessionStartTimeoutMs?: number | undefined;
  /** Missing-findings grace window (ms); defaults to the poll interval. */
  missingFindingsGraceMs?: number | undefined;
  dest?: DestinationStream | undefined;
  /** See `ProcessProjectWorkInput.readLocalEnv`. */
  readLocalEnv?: (() => Promise<Record<string, string>>) | undefined;
  /** See `TaskPlaneWorkerClientOptions.expectedUserId`. */
  expectedUserId?: string | undefined;
  reporter?: WorkReporter | undefined;
  sourceBranch?: string | null | undefined;
  /** See `ProcessProjectWorkInput.slots`. */
  slots?: SlotPort | undefined;
  /** See `ProcessProjectWorkInput.runRegistry`. */
  runRegistry?: RunRegistry | undefined;
  /** See `ProcessProjectWorkInput.drainSignal`. */
  drainSignal?: AbortSignal | undefined;
  /** See `ProcessProjectWorkInput.onLoopError`. */
  onLoopError?: ProcessProjectWorkInput["onLoopError"];
};

export type ProjectWorkHostDeps = {
  createWorkerClient(
    baseUrl: string,
    options: TaskPlaneWorkerClientOptions,
  ): Promise<TaskRunWorkerClient>;
  createRunTracker(): TaskRunTracker;
  runtimeEnvironmentOrchestrator: TaskRuntimeEnvironmentOrchestrator;
  /** Orchestrator for `no_workspace` steps (host OpenCode, no clone/container). */
  noWorkspaceRuntimeEnvironmentOrchestrator?:
    TaskRuntimeEnvironmentOrchestrator | undefined;
  agentRunner: TaskAgentRunner;
  /**
   * Override the artifact store. When omitted the store is resolved from the
   * environment via `resolveArtifactStores` (local + remote by default; local
   * copies land under ~/.scarn/artifacts, remote uploads go through the API).
   */
  artifactStore?: ArtifactStore | undefined;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
  logger: ProjectWorkLogger;
  reporter?: WorkReporter | undefined;
  /** Override the push wake-up client (tests); defaults to the WebSocket one. */
  createWorkSignalClient?:
    ((options: WorkSignalClientOptions) => WorkSignalClient) | undefined;
};

/**
 * Everything one `processProjectWork` call needs. `close` stops the push
 * wake-up socket the setup opened; call it once the loop has returned.
 */
export type ProjectWorkSetup = {
  input: ProcessProjectWorkInput;
  deps: ProjectWorkCoreDeps;
  close(): void;
};

function parsePositiveInt(
  value: string | number | undefined,
  fallback: number,
): number {
  const parsedValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    return fallback;
  }

  return parsedValue;
}

function resolveFromEnv(
  value: number | undefined,
  envName: string,
  fallback: number,
): number {
  return parsePositiveInt(value ?? process.env[envName], fallback);
}

function resolveWorkerId(projectId: string, workerId?: string) {
  const normalizedWorkerId = workerId?.trim();

  if (normalizedWorkerId) {
    return normalizedWorkerId;
  }

  return `scarn-work-${hostname()}-${String(process.pid)}-${projectId}`;
}

function resolveReadWorkItemId(options: ProjectWorkOptions) {
  if (options.readWorkItemId) return options.readWorkItemId;
  const workItemId = options.workItemId;
  return workItemId === undefined ? undefined : () => workItemId;
}

async function startWorkSignal(
  workerClient: TaskRunWorkerClient,
  projectId: UuidV7,
  workerId: string,
  deps: ProjectWorkHostDeps,
): Promise<WorkSignalClient | null> {
  const issueToken = workerClient.issueWorkSignalToken;
  if (!issueToken) {
    return null;
  }
  const client = (deps.createWorkSignalClient ?? createWorkSignalClient)({
    projectId,
    fetchToken: () => issueToken({ projectId, workerId }),
    reporter: deps.reporter,
    logger: deps.logger,
  });
  return (await client.start()) ? client : null;
}

function resolveNumericInput(options: ProjectWorkOptions) {
  const concurrency = resolveFromEnv(
    options.concurrency,
    "SCARN_WORK_CONCURRENCY",
    DEFAULT_WORK_CONCURRENCY,
  );
  const pollIntervalMs = resolveFromEnv(
    options.pollIntervalMs,
    "SCARN_WORK_POLL_INTERVAL_MS",
    DEFAULT_POLL_INTERVAL_MS,
  );
  // A cap below the base interval would be a no-op backoff, so it is clamped
  // up to pollIntervalMs; "equal" is the documented way to opt out.
  const maxPollIntervalMs = Math.max(
    resolveFromEnv(
      options.maxPollIntervalMs,
      "SCARN_WORK_MAX_POLL_INTERVAL_MS",
      DEFAULT_MAX_POLL_INTERVAL_MS,
    ),
    pollIntervalMs,
  );
  return {
    concurrency,
    batchSize: parsePositiveInt(options.batchSize, concurrency),
    pollIntervalMs,
    maxPollIntervalMs,
    connectedMaxPollIntervalMs: resolveFromEnv(
      options.connectedMaxPollIntervalMs,
      "SCARN_WORK_CONNECTED_MAX_POLL_INTERVAL_MS",
      DEFAULT_CONNECTED_MAX_POLL_INTERVAL_MS,
    ),
    leaseDurationSeconds: resolveFromEnv(
      options.leaseDurationSeconds,
      "SCARN_WORK_LEASE_DURATION_SECONDS",
      DEFAULT_LEASE_DURATION_SECONDS,
    ),
  };
}

/**
 * Turns caller options into a ready `processProjectWork` call: resolves the
 * base URL and numeric settings (falling back to `SCARN_WORK_*` env vars),
 * creates the worker client, resolves the artifact store, and opens the push
 * wake-up socket unless `once` is set. Shared by `runProjectWork` and the
 * background worker's project loops.
 *
 * Throws whatever creating the worker client throws (e.g. a
 * `WorkerAuthError`); nothing is left open in that case.
 */
export async function buildProjectWorkSetup(
  options: ProjectWorkOptions,
  hostDeps: ProjectWorkHostDeps,
): Promise<ProjectWorkSetup> {
  const projectId = parseUuidV7(options.projectId);
  const baseUrl = resolveScarnBaseUrl(options.baseUrl);
  const workerClient = await hostDeps.createWorkerClient(baseUrl, {
    expectedUserId: options.expectedUserId,
  });
  const workerId = resolveWorkerId(projectId, options.workerId);

  const artifactStore =
    hostDeps.artifactStore ??
    resolveArtifactStores(
      { ...process.env, ...(await options.readLocalEnv?.()) },
      { remoteUploader: workerClient },
    );

  const workSignal = options.once
    ? null
    : await startWorkSignal(workerClient, projectId, workerId, hostDeps);

  return {
    input: {
      projectId,
      workerId,
      ...resolveNumericInput(options),
      readWorkItemId: resolveReadWorkItemId(options),
      preserveRuntimeOnComplete: options.preserveRuntimeOnComplete,
      once: options.once,
      sessionStartTimeoutMs: options.sessionStartTimeoutMs,
      missingFindingsGraceMs: options.missingFindingsGraceMs,
      readLocalEnv: options.readLocalEnv,
      sourceBranch: options.sourceBranch,
      slots: options.slots,
      runRegistry: options.runRegistry,
      drainSignal: options.drainSignal,
      onLoopError: options.onLoopError,
    },
    deps: {
      workerClient,
      createRunTracker: () => hostDeps.createRunTracker(),
      runtimeEnvironmentOrchestrator: hostDeps.runtimeEnvironmentOrchestrator,
      noWorkspaceRuntimeEnvironmentOrchestrator:
        hostDeps.noWorkspaceRuntimeEnvironmentOrchestrator,
      agentRunner: hostDeps.agentRunner,
      artifactStore,
      sleep: (milliseconds, signal) => hostDeps.sleep(milliseconds, signal),
      wake: workSignal ? (signal) => workSignal.wake(signal) : undefined,
      signalConnection: workSignal ?? undefined,
      logger: {
        debug: (scope, message, details) => {
          hostDeps.logger.debug(scope, message, { projectId, ...details });
        },
        log: (scope, message, details) => {
          hostDeps.logger.log(scope, message, { projectId, ...details });
        },
        error: (scope, message, details) => {
          hostDeps.logger.error(scope, message, { projectId, ...details });
        },
      },
      reporter: hostDeps.reporter,
    },
    close: () => {
      workSignal?.stop();
    },
  };
}

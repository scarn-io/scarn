import type { ArtifactKind } from "@scarn/sdk/contracts/artifacts";
import type {
  ResolvedEnvironment,
  ResolvedEnvironmentRefInput,
} from "@scarn/sdk/environment";
import type { RepoConfig } from "@scarn/sdk/repo-config";
import type { WorkItemChange } from "@scarn/sdk/contracts/work-item-changes";
import type { LaunchedRuntime } from "./launched-runtime";
import type {
  McpBridgeSession,
  OpenMcpBridgeSessionInput,
} from "../../../runtime/mcp-bridge/infra";
import type { UuidV7 } from "../../../common/contracts/uuid-v7";
import type { ArtifactStore } from "../../../artifacts/artifact-store/domain/artifact-store";
import type { RunCodeStepCommand } from "../application/execute-code-step";
import type { McpToolCaller } from "../application/mcp-tool-caller";
import type { FakeAiServer } from "../infra/fake-ai/fake-ai-server";
import type {
  ManagedAuthorityStatus,
  TaskRunContract,
  TaskRunWorkerContextContract,
} from "./task-run-contracts";
import type { TaskLogLinesResult } from "@scarn/shared-core";
import type { CurrentExecutionInfo } from "../application/process-project-work-findings";
import type { PreviousRunFilesInput } from "../application/write-previous-run-files";
import type {
  RunHealthChecksInput,
  HealthCheckReport,
} from "../application/run-health-checks";
import type {
  McpEnvRef,
  ResolvedStepEnv,
} from "../application/resolve-step-env";
import type { WorkReporter } from "./work-reporter";
import type { McpStartupGateOptions } from "../application/mcp-startup-gate";
import type { RunHandle, RunRegistry } from "../application/run-registry";
import type * as Tokens from "./socket-token-types";
import type { SlotPort } from "../../worker-host/contracts/slot-port";
import type { OpencodeServerHandle } from "../../../runtime/runtime-service/infra/opencode-server-contract";
import type { TaskAgentRunner } from "./task-agent-runner";
import type { RepoContextLaunchInput } from "./repo-context-launch-input";
import type {
  ManagedLaunchEntries,
  ManagedLaunchRegistration,
  RegisterManagedLaunch,
} from "./managed-launch-types";

export type { RepoContextLaunchInput };

export type { LaunchedRuntime };

export type { OpencodeServerHandle };

export type {
  AgentTurn,
  ExportedAgentSession,
  TaskAgentRunner,
} from "./task-agent-runner";

export type ProcessProjectWorkInput = {
  projectId: UuidV7;
  batchSize: number;
  concurrency: number;
  pollIntervalMs: number;
  maxPollIntervalMs?: number | undefined;
  /**
   * Safety-net poll interval while the push wake-up socket is connected. An
   * empty poll while connected sleeps straight for
   * `max(maxPollIntervalMs, connectedMaxPollIntervalMs)` with no doubling;
   * on disconnect the backoff drops back to `maxPollIntervalMs`.
   */
  connectedMaxPollIntervalMs?: number | undefined;
  leaseDurationSeconds: number;
  workerId: string;
  /**
   * The work item the loop claims runs for, read before every claim so the
   * filter can change while the loop runs. Claims any run when omitted or
   * when it returns `undefined`.
   */
  readWorkItemId?: (() => string | undefined) | undefined;
  preserveRuntimeOnComplete?: boolean | undefined;
  once?: boolean | undefined;
  sessionStartTimeoutMs?: number | undefined;
  /**
   * Length of each missing-findings grace window (ms), measured as poll sleep
   * time while the session is stopped without findings. The monitor waits one
   * window for late writes before sending the retry prompt, one after the
   * retry, and one more before failing. Every window spans at least one poll.
   * Defaults to `pollIntervalMs`, i.e. one poll per window.
   */
  missingFindingsGraceMs?: number | undefined;
  /**
   * Reads the project's `.scarn/.env`. Called once per claim, so an edited
   * file applies to the next run. Its values override `process.env` in the
   * run's worker env (the source of `Env.inherit` entries and prompt
   * `{{env.X}}` tokens), are masked in the run's log feed, and are baked into
   * the runtime container. No local vars when omitted.
   */
  readLocalEnv?: (() => Promise<Record<string, string>>) | undefined;
  /**
   * Where this loop records its runs so they can be listed and aborted.
   * Shared when several project loops run in one worker; a fresh registry is
   * created per call when omitted. Concurrency counts only this project's runs.
   */
  runRegistry?: RunRegistry | undefined;
  /**
   * Stops the loop from taking new work. When it fires, the polling loop cuts
   * its idle sleep short and returns, and the call settles once the active
   * runs have finished, as with `once`.
   */
  drainSignal?: AbortSignal | undefined;
  /**
   * Where the loop reserves run slots. Shared when several project loops run
   * in one worker, so together they stay within the machine limit. When
   * omitted, the loop gets a private allocator capped at `concurrency`.
   */
  slots?: SlotPort | undefined;
  /**
   * Called as soon as the polling loop throws, so a caller can react while
   * the runs already claimed keep going. The call itself rejects with the
   * same error once those runs have settled.
   */
  // eslint-disable-next-line local/no-unknown-parameter-type -- whatever the loop threw
  onLoopError?: ((error: unknown) => void) | undefined;
};

/**
 * Default cap on how long the monitor waits for the agent session to start
 * (report `busy`/`retry`) before failing fast. Sized to comfortably cover
 * OpenCode session creation + first model turn, while surfacing a broken
 * agent/provider connection in ~1 min instead of hanging.
 */
export const DEFAULT_SESSION_START_TIMEOUT_MS = 60_000;

/**
 * Fallback cap on the number of "waiting for the agent session to start" polls
 * when `pollIntervalMs` is 0 (so elapsed time never accrues). Keeps the
 * fail-fast guard effective in that degenerate configuration.
 */
export const DEFAULT_SESSION_START_MAX_POLLS = 60;

export type ProcessProjectWorkResult = {
  claimedCount: number;
  processedCount: number;
  skippedCount: number;
};

export type TaskRunWorkerClaim = {
  task: {
    id: UuidV7;
  };
  claimToken: string;
  logFeed?: Tokens.LogFeedToken | null | undefined;
};

export type TaskRunWorkerContext = TaskRunWorkerContextContract;

export type TaskLogStream = "worker" | "ai-server" | "conversation";

export type TaskLogLevel = "debug" | "info" | "warn" | "error";

export type TaskLogLine = {
  seq: number;
  stream: TaskLogStream;
  ts: string;
  content: string;
  level: TaskLogLevel;
};

export type { WorkSignalToken } from "./socket-token-types";

export type TaskRunWorkerClient = {
  userId: UuidV7;
  /**
   * The Scarn base URL this client talks to. The agent's live work item reads
   * go there too; absent on clients with no API behind them, which leaves the
   * agent without `scarn-get-work-item`.
   */
  apiBaseUrl?: string | undefined;
  /**
   * Issues a short-lived token for the push wake-up socket. Resolves `null`
   * when the server has push disabled (404). Absent on clients with no API
   * behind them, which keeps the worker on plain polling.
   */
  issueWorkSignalToken?:
    | ((input: {
        projectId: UuidV7;
        workerId: string;
      }) => Promise<Tokens.WorkSignalToken | null>)
    | undefined;
  issueLogFeedWriteToken?: Tokens.IssueLogFeedWriteToken | undefined;
  claimTaskRuns(input: {
    projectId: UuidV7;
    workerId: string;
    batchSize: number;
    leaseDurationSeconds: number;
    workItemId?: string | undefined;
  }): Promise<TaskRunWorkerClaim[]>;
  /**
   * Pins a chat run's commit, and its branch when the run has none. The
   * first report wins; returns the stored values, which the run must use.
   */
  reportTaskRunBaseCommit(input: {
    taskRunId: UuidV7;
    claimToken: string;
    baseCommit: string;
    baseBranch?: string | undefined;
  }): Promise<{ baseCommit: string; baseBranch: string | null }>;
  heartbeatTaskRun(input: {
    taskRunId: UuidV7;
    claimToken: string;
    leaseDurationSeconds: number;
  }): Promise<
    Pick<TaskRunContract, "status"> & {
      managedAuthority: ManagedAuthorityStatus;
    }
  >;
  /**
   * Fetches the named project secrets for a claimed run (one call per run).
   * Absent on clients with no API behind them; a run that needs a secret
   * `.scarn/.env` lacks then fails.
   */
  resolveTaskRunEnvironment?:
    | ((input: {
        taskRunId: UuidV7;
        claimToken: string;
        secretNames: string[];
      }) => Promise<{
        secrets: Record<string, { value: string; expiresAt: string | null }>;
        missing: string[];
      }>)
    | undefined;
  /**
   * Registers a claimed run's managed launch with its resolved MCP server
   * URLs and returns each connection-auth server's relay entry by key.
   * Throws `ManagedConnectionNotReadyError` when a connection isn't serving,
   * `McpConnectionAuthRejectedError` when the server refuses a URL. Absent
   * on clients with no API behind them; a managed-connection step then fails.
   */
  registerTaskRunManagedLaunch?:
    | ((input: ManagedLaunchRegistration) => Promise<ManagedLaunchEntries>)
    | undefined;
  failTaskRun(input: {
    taskRunId: UuidV7;
    claimToken: string;
    resultJson: unknown;
    errorJson: unknown;
  }): Promise<void>;
  completeTaskRun(input: {
    taskRunId: UuidV7;
    claimToken: string;
    resultJson: unknown;
    errorJson: unknown;
    /**
     * The `scarn/...` branch the agent committed to, and the branch it was
     * created off of. Sent as dedicated fields (NOT inside `resultJson`). Null
     * for runs without a step key (e.g. no_workspace) or when pushing the work
     * branch failed under `onPushFailure: "warn"`.
     */
    workBranch: string | null;
    createdFromBranch: string | null;
    /**
     * Whether the previous Task's agent session was restored; null (or
     * absent) when there was nothing to restore.
     */
    sessionRestored?: boolean | null | undefined;
    /**
     * The work item changes the agent's tools recorded; the server applies
     * them with the completion.
     */
    workItemChanges?: WorkItemChange[] | undefined;
  }): Promise<void>;
  /**
   * Park the task after its agent's turn ended with a yield, handing the
   * conversation to a person: `message` is the agent's final message
   * (already masked). The work branch fields follow the same rules as
   * {@link completeTaskRun}. `sessionObjectKey` is the key the exported
   * OpenCode session was uploaded to (see {@link createSessionUploadUrl}),
   * null when the export or upload failed. `sessionSizeBytes` is the size of
   * the uploaded body, null without a session.
   */
  yieldTaskRun(input: {
    taskRunId: UuidV7;
    claimToken: string;
    workBranch: string | null;
    createdFromBranch: string | null;
    sessionObjectKey: string | null;
    sessionSizeBytes: number | null;
    sessionRestored: boolean | null;
    message: string;
  }): Promise<void>;
  appendTaskLogs(input: {
    taskRunId: UuidV7;
    claimToken: string;
    lines: TaskLogLine[];
  }): Promise<{ nextOffset: number }>;
  getTaskRun(input: {
    taskRunId: UuidV7;
  }): Promise<Pick<TaskRunContract, "status">>;
  /**
   * Every stream's log lines of another Task (a steered rerun's previous
   * run): its archive once completed, the live feed otherwise. Read failures
   * come back as `{ unavailable }`; a failed archive download throws. Absent
   * on clients that cannot read logs, which skips the previous-run transcript.
   */
  loadTaskLogLines?(input: { taskRunId: string }): Promise<TaskLogLinesResult>;
  getTaskRunWorkerContext(input: {
    taskRunId: UuidV7;
    claimToken: string;
  }): Promise<TaskRunWorkerContextContract>;
  /**
   * A live read of a work item the run may see, with its claim token. Absent
   * on clients with no API behind them, which renders a commit message's
   * `{{workItem.…}}` tokens empty.
   */
  readTaskRunWorkItem?(input: {
    taskRunId: string;
    claimToken: string;
    workItemId: string;
  }): Promise<{ title: string; platformKey: string }>;
  createArtifactUploadUrl(input: {
    taskRunId: string;
    claimToken: string;
    relativeStorePath: string;
    contentType?: string | undefined;
    /**
     * The artifact's byte size, known here because the store reads the full
     * file into memory before requesting the upload URL (see
     * `RemoteArtifactStore.saveArtifact`). Passed through so the API's
     * pre-flight usage guard can check real storage headroom instead of only
     * the write-count cap.
     */
    sizeBytes?: number | undefined;
  }): Promise<{
    uploadUrl: string;
    storeRef: string;
    objectKey: string;
    expiresInSeconds: number;
  }>;
  /**
   * A presigned PUT URL for the Task's exported agent session, uploaded as
   * JSON before the Task yields. `sizeBytes` feeds the storage pre-flight.
   */
  createSessionUploadUrl(input: {
    taskRunId: string;
    claimToken: string;
    sizeBytes?: number | undefined;
  }): Promise<{
    uploadUrl: string;
    objectKey: string;
    expiresInSeconds: number;
  }>;
  recordArtifact(input: {
    taskRunId: string;
    claimToken: string;
    objectKey: string;
    relativeStorePath: string;
    sizeBytes: number;
    contentType?: string | undefined;
    kind: ArtifactKind;
  }): Promise<void>;
  /**
   * Best-effort telemetry for an artifact-save attempt that failed (storage
   * quota, network error, etc.). Purely informational — callers must treat a
   * failure to report as non-fatal (see `collectStepArtifacts`'s own
   * try/catch around this call) since it must never mask the real save
   * failure it is reporting.
   */
  recordArtifactFailure(input: {
    taskRunId: string;
    claimToken: string;
    relativeStorePath: string;
    attemptedSizeBytes: number;
    kind?: ArtifactKind | undefined;
    errorCode: string;
    errorMessage: string;
    httpStatus?: number | undefined;
  }): Promise<void>;
};

/**
 * Narrow port used by the remote artifact store to upload artifacts through the
 * API. The full {@link TaskRunWorkerClient} satisfies this subset.
 */
export type RemoteArtifactUploader = Pick<
  TaskRunWorkerClient,
  "createArtifactUploadUrl" | "recordArtifact"
>;

export type LaunchedRuntimeOrchestrator = {
  launch(input: {
    environment: ResolvedEnvironmentRefInput;
    taskKind?: TaskRunWorkerContextContract["task"]["kind"] | undefined;
    resolveEnvironmentEnv?:
      | ((environment: ResolvedEnvironment) => Promise<{
          resolved: ResolvedStepEnv;
          resolveMcpEnv:
            ((refs: readonly McpEnvRef[]) => ResolvedStepEnv) | undefined;
          fakeAiProviderOverride?: { baseUrl: string } | undefined;
        }>)
      | undefined;
    resolveFakeAiProviderOverride?:
      ((environment: ResolvedEnvironment) => { baseUrl: string }) | undefined;
    resolveCurrentExecutionInfo?:
      ((environment: ResolvedEnvironment) => CurrentExecutionInfo) | undefined;
    /**
     * Whether to start the agent (OpenCode server) alongside the runtime.
     * Required so every caller states intent.
     */
    startAgent: boolean;
    sessionId: UuidV7;
    projectId: UuidV7;
    requestedByUserId: UuidV7;
    gitUrl: string;
    /** The run's claim token; scopes the git credential relay's source. */
    claimToken: string;
    /**
     * Receives secret values issued during the run (git credential relay
     * passwords). Register them with the log masker.
     */
    onSecretValues?: ((values: readonly string[]) => void) | undefined;
    /**
     * Called before OpenCode starts when the step's MCP servers use a managed
     * connection; the relay entries replace those servers. Absent for launches
     * that can't register one (dry runs), where such a step fails.
     */
    registerManagedLaunch?: RegisterManagedLaunch | undefined;
    /**
     * The branch the run starts from, handed down by the server: the Task's
     * continued branch, or the previous step's work branch when the step sets
     * no `baseBranch`. Beats every other base. Null otherwise.
     */
    baseWorkBranch?: string | null | undefined;
    /**
     * The step's `baseBranch` already rendered, for a dry run, which renders
     * only `env` tokens itself (null: not rendered). Undefined renders
     * `repo.baseBranch` after the environment is read (`renderBaseBranch`).
     */
    stepBaseBranch?: string | null | undefined;
    /**
     * The project's `.scarn/.env` values, read for this run. Baked into the
     * devcontainer's env and consulted for the configured base work branch
     * and git cache/credential settings. Ignored by the no-workspace
     * orchestrator.
     */
    localEnvVars?: Readonly<Record<string, string>> | undefined;
    /** Step key used (sanitized) in the work branch name `scarn/<key>-<id>`. */
    stepKey?: string | undefined;
    opencodeMcpJson?: TaskRunWorkerContextContract["runtime"]["opencodeMcpJson"];
    /** The Task's extra connectors, merged into the environment before its vars resolve. */
    extraConnectors?:
      TaskRunWorkerContextContract["runtime"]["extraConnectors"] | undefined;
    currentExecutionInfo: CurrentExecutionInfo;
    /** Optional reporter to emit granular sub-step progress events during launch. */
    reporter?: WorkReporter | undefined;
    taskRunId?: string | undefined;
    /**
     * Optional sink for individual devcontainer launch log lines, wired to the
     * step's log shipper so the CLI's real subprocess output streams to the
     * durable feed as it appears (separate from the presentation `reporter`).
     */
    onDevcontainerLogLine?:
      ((line: string, level: "info" | "warn" | "error") => void) | undefined;
    /**
     * Called as soon as the OpenCode serve log exists on the host, i.e. while
     * the agent is still starting. Lets the caller mirror the log into the
     * durable feed during startup, so a launch that fails (and tears the log
     * down) still leaves its output behind. Only the no-workspace (host)
     * orchestrator calls it; `hostLogPath` is the file to tail. `secretValues`
     * are the provider token(s) injected into the process: register them with
     * the log masker BEFORE tailing, since the raw log can echo them.
     */
    onAgentLogReady?:
      | ((log: {
          logDirectory: string;
          hostLogPath: string;
          secretValues: readonly string[];
        }) => void)
      | undefined;
    /**
     * Opt-in hook that bakes a fake AI provider into the launch-time inline
     * config, pointed at `baseUrl`, instead of PATCHing `/config` on an
     * already-running agent (proven to have zero live effect — see #109).
     * Set by `run --dry-run` (#109/#110) and, since #120, by real step
     * execution for steps that declare `healthChecks` — a step declaring none
     * never sets this field, so it launches unaffected exactly as before.
     */
    fakeAiProviderOverride?: { baseUrl: string } | undefined;
    /**
     * The step's resolved environment variables (`resolveStepEnv`), injected
     * into the OpenCode process: `docker exec -e` in the container, the spawn
     * env on the host. Values are never logged; only the key names are.
     */
    stepEnv?: Readonly<Record<string, string>> | undefined;
    /**
     * The step's resolved setup variables (`applies: "setup" | "both"`, D13),
     * passed to `devcontainer up` as its host env so `initializeCommand` and
     * the image build see them. Never reaches the agent. Ignored by the
     * no-workspace orchestrator, which has no container to set up.
     */
    setupEnv?: Readonly<Record<string, string>> | undefined;
    /**
     * Set when the step names MCP server refs (`planStepEnv`). Called with
     * each ref's `requiredEnv` once the launch has discovered them; its
     * result replaces {@link stepEnv} (adding the inferred variables, D3).
     * Throws `MissingStepEnvError` before anything starts when a variable is
     * missing.
     */
    resolveMcpEnv?:
      ((refs: readonly McpEnvRef[]) => ResolvedStepEnv) | undefined;
    /**
     * When true (`scarn work -k`), a launch that throws leaves its runtime in
     * place and logs where, instead of tearing it down: the workspace
     * orchestrator keeps the devcontainer and cloned workspace; the
     * no-workspace orchestrator keeps the temp workdir and agent HOME (with the
     * OpenCode serve log).
     */
    preserveRuntimeOnFailure?: boolean | undefined;
    /**
     * The step's resolved repository access. `readOnly` checks out the base but
     * creates no work branch and never commits or pushes; `readWrite` creates the
     * work branch and commits and pushes per its `message` / `onPushFailure`.
     * `none` is for steps with no clone: the no-workspace orchestrator accepts it
     * and the workspace orchestrator rejects it.
     */
    repo: RepoConfig;
    /**
     * The task's additional input, the `{{input.…}}` source of a
     * `readWrite` commit message template.
     */
    stepInputJson?: unknown;
    /**
     * Reads the Task's work item live at commit time, the source of a
     * `readWrite` commit message's `{{workItem.…}}` tokens; null on failure.
     */
    loadCommitWorkItem?:
      | (() => Promise<{ title: string; platformKey: string } | null>)
      | undefined;
    /**
     * Set for a steered rerun: the previous run's findings and transcript are
     * written into the workspace right after the current-execution metadata
     * (see `writePreviousRunFiles`). Absent for every other run.
     */
    previousRun?: PreviousRunFilesInput | undefined;
    /**
     * Set for a chat run: the workspace is parked detached on the pinned
     * commit instead of a branch, and {@link baseWorkBranch} is ignored.
     * Only the workspace orchestrator
     * supports it.
     */
    repoContext?: RepoContextLaunchInput | undefined;
    /**
     * Receives timing lines for the clone (mirror refresh, local clone,
     * fallback) and the work-branch preparation at info level. Set from the
     * step's tee logger so they reach the shipped step log.
     */
    logger?: ProjectWorkLogger | undefined;
  }): Promise<LaunchedRuntime>;
};

export type StartedClaimedTask = {
  projectId: UuidV7;
  localRuntimeSessionId: UuidV7;
  taskRunId: UuidV7;
  claimToken: string;
  agentSessionId: string | null;
  /**
   * Whether the previous Task's agent session was restored into this run;
   * null (or absent) when there was nothing to restore. Reported on
   * completion and on yield.
   */
  sessionRestored?: boolean | null | undefined;
  environment: LaunchedRuntime;
  /**
   * True once the server said the run is gone or the claim was revoked (see
   * `TaskRunCancelledError`). Absent means never cancelled.
   */
  isCancelled?: (() => boolean) | undefined;
  /** The run's registry handle, for watching aborts and reporting phase. */
  run?: RunHandle | undefined;
};

export type TaskRunTracker = {
  createSession(input: {
    id: string;
    projectId: string;
    taskRunId: string;
    metadataJson?: string | null | undefined;
  }): void | Promise<void>;
  markRunning(input: {
    id: string;
    workspacePath: string;
    /** `null` for `no_workspace` runs, which have no container. */
    runtimeContainerId: string | null;
    agentBaseUrl: string | null;
    metadataJson?: string | null | undefined;
  }): void | Promise<void>;
  attachAgentSession(input: {
    id: string;
    agentSessionId: string;
    metadataJson?: string | null | undefined;
  }): void | Promise<void>;
  markSucceeded(input: {
    id: string;
    metadataJson?: string | null | undefined;
  }): void | Promise<void>;
  markFailed(input: {
    id: string;
    failureReason: string;
    metadataJson?: string | null | undefined;
  }): void | Promise<void>;
  close(): void | Promise<void>;
};

export type ProjectWorkLogger = {
  debug(
    scope: string,
    message: string,
    details?: Record<string, unknown>,
  ): void;
  log(scope: string, message: string, details?: Record<string, unknown>): void;
  error(
    scope: string,
    message: string,
    details?: Record<string, unknown>,
  ): void;
};

export type { WorkEvent, WorkReporter, WorkActivity } from "./work-reporter";

export type WorkSignalConnection = {
  isConnected(): boolean;
  disconnected(signal: AbortSignal): Promise<void>;
};

export type ProcessProjectWorkDeps = {
  workerClient: TaskRunWorkerClient;
  createRunTracker(): TaskRunTracker;
  /**
   * Shared checkout orchestrator for host and container runtimes.
   */
  runtimeEnvironmentOrchestrator: LaunchedRuntimeOrchestrator;
  agentRunner: TaskAgentRunner;
  artifactStore: ArtifactStore;
  /**
   * Resolves after `milliseconds`. When raced against {@link wake}, `signal`
   * aborts once the race settles so the losing timer can be cleared.
   */
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
  /**
   * Resolves when a push wake-up arrives (immediately if one arrived since the
   * previous call). Raced against {@link sleep}; a wake re-polls at once and
   * resets the idle backoff. `signal` aborts when sleep wins, so the stale
   * waiter is dropped and a later wake is kept for the next call instead of
   * being swallowed. Omitted means plain polling.
   */
  wake?: ((signal: AbortSignal) => Promise<void>) | undefined;
  /**
   * Connection state of the push wake-up socket. While connected, the idle
   * backoff may grow to `connectedMaxPollIntervalMs`; `disconnected` resolves
   * on the next disconnect (at once if not connected) so a long sleep can be
   * cut back to the normal ceiling. Omitted means plain polling ceilings.
   */
  signalConnection?: WorkSignalConnection | undefined;
  /** Clock for measuring idle sleeps; defaults to `Date.now`. */
  now?: (() => number) | undefined;
  logger?: ProjectWorkLogger | undefined;
  /**
   * Optional user-facing presentation surface. Distinct from {@link logger}
   * (diagnostics). When omitted, milestone events are dropped (see
   * {@link resolveProjectWorkReporter}).
   */
  reporter?: WorkReporter | undefined;
  /**
   * The health check runner (#119/#120). Overridable so unit tests can inject
   * a fake without exercising the real forced-tool-call machinery — the same
   * seam {@link agentRunner} already provides. Defaults to the real
   * `runHealthChecks` when omitted. Only ever invoked for a step that
   * declares a non-empty `healthChecks`.
   */
  runHealthChecks?:
    ((input: RunHealthChecksInput) => Promise<HealthCheckReport[]>) | undefined;
  /**
   * Factory for the fake-AI harness a health-check-declaring step's forced
   * tool calls run through. Overridable for the same reason as
   * {@link runHealthChecks}. Defaults to `() => new FakeAiServer()`.
   */
  createFakeAiServer?: (() => FakeAiServer) | undefined;
  /**
   * Poll window/interval for the MCP startup gate (`mcp-startup-gate.ts`).
   * Defaults to a 60s window; tests shorten it.
   */
  mcpStartupGate?: McpStartupGateOptions | undefined;
  /**
   * Injectable command-runner seam for `kind: "code"` task run
   * (`execute-code-step.ts`). Overridable so unit tests can assert on the
   * constructed `docker exec`/host command without ever shelling out to a
   * real `docker`/`sh` binary — the same seam
   * `process-project-work-monitor-helpers.ts`'s `runDockerExec` param
   * provides. Defaults to `defaultRunCodeStepCommand` when omitted.
   */
  runCodeStepCommand?: RunCodeStepCommand | undefined;
  /**
   * Calls the tool of a `kind: "mcp_tool"` task run. Defaults to
   * `SdkMcpToolCaller` when omitted; unit tests pass a fake.
   */
  mcpToolCaller?: McpToolCaller | undefined;
  /**
   * Opens the MCP bridge session of a code step that declares MCP servers.
   * Defaults to `openMcpBridgeSession` when omitted; unit tests pass a fake.
   */
  openMcpBridgeSession?:
    | ((input: OpenMcpBridgeSessionInput) => Promise<McpBridgeSession>)
    | undefined;
};

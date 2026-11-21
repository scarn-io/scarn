import type { UuidV7 } from "../../../common/contracts/uuid-v7";
import { resolveProjectWorkLogger } from "./process-project-work-logger";
import type {
  ProcessProjectWorkDeps,
  TaskRunWorkerClient,
} from "../contracts/process-project-work-types";
import type { TaskRunStatus } from "../contracts/task-run-contracts";
import { isTaskRunCancelledResponse } from "./task-run-cancelled-error";
import type { RunHandle } from "./run-registry";

function getHeartbeatPollDelayMs(leaseDurationSeconds: number) {
  return Math.max(1_000, Math.floor((leaseDurationSeconds * 1_000) / 2));
}

/**
 * Statuses the worker's own completion moves a run to. A heartbeat seeing one
 * stops, but aborts nothing: the run already ended the way it meant to.
 */
const SELF_REPORTED_STATUSES: ReadonlySet<TaskRunStatus> = new Set([
  "succeeded",
  "yielded",
]);

/**
 * Keeps a claimed run's lease alive and watches what the server says about
 * it. A run the server ended (gone, claim revoked, cancelled, timed out) is
 * aborted with `cancelled`, so work in flight (an MCP tool call, say) stops
 * at once rather than at the monitor's next poll. A heartbeat reporting
 * `managedAuthority.lost` aborts the run with `managed_authority_lost`. Once
 * {@link armManagedWatchdog} is called (the run has a managed launch), a
 * whole lease without an accepted heartbeat aborts it the same way with
 * `control_lost`: the server stops relaying the run's calls once its lease
 * lapses (decision 6).
 */
export function createTaskRunHeartbeatController(
  client: TaskRunWorkerClient,
  deps: Pick<ProcessProjectWorkDeps, "sleep" | "logger">,
  input: {
    taskRunId: UuidV7;
    claimToken: string;
    leaseDurationSeconds: number;
    run: Pick<RunHandle, "abortManagedAuthorityLost" | "abortCancelled">;
  },
) {
  const logger = resolveProjectWorkLogger(deps);
  // Heartbeat ticks are high-frequency, low-signal. Log them at `debug` so they
  // stay in local diagnostics but are dropped from the durable feed/archive
  // (keeps Postgres/S3 volume down).
  const pollDelayMs = getHeartbeatPollDelayMs(input.leaseDurationSeconds);

  logger.debug("heartbeat", "Starting heartbeat loop", {
    taskRunId: input.taskRunId,
    leaseDurationSeconds: input.leaseDurationSeconds,
    pollDelayMs,
  });

  let resolveStopSignal: (() => void) | null = null;
  const stopSignal = new Promise<void>((resolve) => {
    resolveStopSignal = resolve;
  });
  let activePollTimeout: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  let lastKnownStatus: TaskRunStatus = "running";
  let lastAcceptedAt = Date.now();
  let watchdogTimeout: ReturnType<typeof setTimeout> | null = null;
  let watchdogArmed = false;
  let stopped = false;

  function clearWatchdog(): void {
    if (watchdogTimeout !== null) {
      clearTimeout(watchdogTimeout);
      watchdogTimeout = null;
    }
  }

  function scheduleWatchdog(): void {
    clearWatchdog();
    if (!watchdogArmed || stopped) return;
    const leaseMs = input.leaseDurationSeconds * 1_000;
    const remainingMs = Math.max(0, lastAcceptedAt + leaseMs - Date.now());
    watchdogTimeout = setTimeout(() => {
      watchdogTimeout = null;
      watchdogArmed = false;
      logger.error(
        "heartbeat",
        "No heartbeat accepted for a whole lease; aborting the run that uses a managed connection",
        {
          taskRunId: input.taskRunId,
          leaseDurationSeconds: input.leaseDurationSeconds,
        },
      );
      input.run.abortManagedAuthorityLost("control_lost");
    }, remainingMs);
  }

  function waitForNextPoll(): Promise<void> {
    return new Promise((resolve) => {
      activePollTimeout = setTimeout(() => {
        activePollTimeout = null;
        resolve();
      }, pollDelayMs);
    });
  }

  const runLoop = (async () => {
    for (;;) {
      const shouldStop = await Promise.race([
        waitForNextPoll().then(() => false),
        stopSignal.then(() => true),
      ]);
      if (shouldStop) {
        return;
      }

      try {
        logger.debug("heartbeat", "Sending heartbeat", {
          taskRunId: input.taskRunId,
          leaseDurationSeconds: input.leaseDurationSeconds,
        });
        const taskRun = await client.heartbeatTaskRun({
          taskRunId: input.taskRunId,
          claimToken: input.claimToken,
          leaseDurationSeconds: input.leaseDurationSeconds,
        });
        lastKnownStatus = taskRun.status;
        lastAcceptedAt = Date.now();
        scheduleWatchdog();
        if (taskRun.status !== "running") {
          cancelled = true;
          if (!SELF_REPORTED_STATUSES.has(taskRun.status)) {
            input.run.abortCancelled();
          }
          logger.log(
            "heartbeat",
            "Task run is no longer running; stopping heartbeat",
            { taskRunId: input.taskRunId, status: taskRun.status },
          );
          return;
        }
        if (taskRun.managedAuthority !== "ok") {
          logger.error(
            "heartbeat",
            "A managed connection the run uses lost its authority; aborting the run",
            {
              taskRunId: input.taskRunId,
              reason: taskRun.managedAuthority.lost,
            },
          );
          input.run.abortManagedAuthorityLost(taskRun.managedAuthority.lost);
        }
        logger.debug("heartbeat", "Heartbeat accepted", {
          taskRunId: input.taskRunId,
        });
      } catch (error) {
        if (isTaskRunCancelledResponse(error)) {
          cancelled = true;
          input.run.abortCancelled();
          logger.log(
            "heartbeat",
            "Task run is gone or its claim was revoked; stopping heartbeat",
            { taskRunId: input.taskRunId },
          );
          return;
        }
        logger.error("heartbeat", "Heartbeat failed", {
          taskRunId: input.taskRunId,
          error,
        });
      }
    }
  })();

  return {
    /**
     * True once a heartbeat was refused because the run is gone (404) or the
     * claim was revoked (409), or was accepted but reported a status other
     * than `running`. The loop stops itself at that point.
     */
    isCancelled(): boolean {
      return cancelled;
    },
    /** Status from the most recent accepted heartbeat; `running` until then. */
    lastKnownStatus(): TaskRunStatus {
      return lastKnownStatus;
    },
    /**
     * Starts the control-loss watchdog, for a run with a managed launch: a
     * whole lease since the last accepted heartbeat (or the claim) aborts
     * the run with `managed_authority_lost` (`control_lost`).
     */
    armManagedWatchdog(): void {
      if (watchdogArmed || stopped) return;
      watchdogArmed = true;
      scheduleWatchdog();
    },
    async stop() {
      logger.debug("heartbeat", "Stopping heartbeat loop", {
        taskRunId: input.taskRunId,
      });
      stopped = true;
      clearWatchdog();
      if (activePollTimeout !== null) {
        clearTimeout(activePollTimeout);
        activePollTimeout = null;
      }
      resolveStopSignal?.();
      await runLoop;
      logger.debug("heartbeat", "Heartbeat loop stopped", {
        taskRunId: input.taskRunId,
      });
    },
  };
}

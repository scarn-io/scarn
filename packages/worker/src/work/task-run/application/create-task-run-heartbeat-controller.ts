import type { UuidV7 } from "../../../common/contracts/uuid-v7";
import { resolveProjectWorkLogger } from "./process-project-work-logger";
import type {
  ProcessProjectWorkDeps,
  TaskRunWorkerClient,
} from "../contracts/process-project-work-types";

function getHeartbeatPollDelayMs(leaseDurationSeconds: number) {
  return Math.max(1_000, Math.floor((leaseDurationSeconds * 1_000) / 2));
}

export function createTaskRunHeartbeatController(
  client: TaskRunWorkerClient,
  deps: Pick<ProcessProjectWorkDeps, "sleep" | "logger">,
  input: {
    taskRunId: UuidV7;
    claimToken: string;
    leaseDurationSeconds: number;
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
        await client.heartbeatTaskRun({
          taskRunId: input.taskRunId,
          claimToken: input.claimToken,
          leaseDurationSeconds: input.leaseDurationSeconds,
        });
        logger.debug("heartbeat", "Heartbeat accepted", {
          taskRunId: input.taskRunId,
        });
      } catch (error) {
        logger.error("heartbeat", "Heartbeat failed", {
          taskRunId: input.taskRunId,
          error,
        });
      }
    }
  })();

  return {
    async stop() {
      logger.debug("heartbeat", "Stopping heartbeat loop", {
        taskRunId: input.taskRunId,
      });
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

import { createTaskRunHeartbeatController } from "./create-task-run-heartbeat-controller";
import { failClaimedTaskRunIfStillRunning } from "./fail-claimed-task-run-if-still-running";
import { monitorStartedClaimedTaskRun } from "./process-project-work-monitor";
import { startProcessClaimedTaskRun } from "./process-claimed-task-run";
import { resolveProjectWorkLogger } from "./process-project-work-logger";
import { TaskLogStreaming } from "./start-task-log-streaming";
import { TaskRunCancelledError } from "./task-run-cancelled-error";
import type { RunRegistry } from "./run-registry";
import type {
  ProcessProjectWorkDeps,
  ProcessProjectWorkInput,
  TaskRunWorkerClaim,
} from "../contracts/process-project-work-types";

type WorkTotals = {
  claimedCount: number;
  processedCount: number;
  skippedCount: number;
};

export function scheduleClaimedTaskRunJob(
  input: ProcessProjectWorkInput,
  deps: ProcessProjectWorkDeps,
  claim: TaskRunWorkerClaim,
  tracker: ReturnType<ProcessProjectWorkDeps["createRunTracker"]>,
  totals: WorkTotals,
  runs: RunRegistry,
): Promise<void> {
  const baseLogger = resolveProjectWorkLogger(deps);

  // Start live log streaming as early as the claim so the *entire* lifecycle
  // (runtime setup, clone, container build, OpenCode bootstrap, monitoring) is
  // mirrored to the platform — not just the monitoring phase. The returned
  // logger tees worker diagnostics into the feed while preserving CLI/file
  // output. The per-job deps below route all downstream logging through it.
  const logStream = new TaskLogStreaming({
    workerClient: deps.workerClient,
    logger: baseLogger,
    taskRunId: claim.task.id,
    claimToken: claim.claimToken,
    logFeed: claim.logFeed ?? null,
  });
  const logger = logStream.logger;
  const streamingDeps: ProcessProjectWorkDeps = { ...deps, logger };

  logger.log("worker", "Scheduling claimed task", {
    projectId: input.projectId,
    workerId: input.workerId,
    taskRunId: claim.task.id,
    activeJobsBeforeSchedule: runs.count({ projectId: input.projectId }),
  });

  const heartbeat = createTaskRunHeartbeatController(
    deps.workerClient,
    streamingDeps,
    {
      taskRunId: claim.task.id,
      claimToken: claim.claimToken,
      leaseDurationSeconds: input.leaseDurationSeconds,
    },
  );

  const job = runs.start(
    { taskRunId: claim.task.id, projectId: input.projectId },
    async (run) => {
      // Capture any thrown error so the finally block can report the step as
      // failed *after* flushing buffered logs. Flushing first is critical:
      // appendTaskLogs rejects once the step leaves "running", so any
      // lines still in the shipper buffer at the moment failTaskRun is
      // called would be permanently lost.
      let executionError: unknown = undefined;
      try {
        // Path A: the run's .scarn/.env values are masked in the shipped feed.
        // Provider token(s) (Path B) are registered later, from the launch.
        const localEnvVars = (await input.readLocalEnv?.()) ?? {};
        logStream.registerSecretValues(Object.values(localEnvVars));
        const startedTask = await startProcessClaimedTaskRun(
          {
            projectId: input.projectId,
            requestedByUserId: deps.workerClient.userId,
            claim,
            leaseDurationSeconds: input.leaseDurationSeconds,
            sourceBranch: input.sourceBranch,
            localEnvVars,
            preserveRuntimeOnFailure: input.preserveRuntimeOnComplete ?? false,
            run,
          },
          streamingDeps,
          deps.workerClient,
          tracker,
          logStream,
        );

        await monitorStartedClaimedTaskRun(
          input,
          streamingDeps,
          tracker,
          {
            ...startedTask,
            isCancelled: () =>
              heartbeat.isCancelled() || run.abortReason() === "cancelled",
            run,
          },
          heartbeat,
          logStream,
        );
      } catch (error: unknown) {
        executionError = run.abortError() ?? error;
        throw executionError;
      } finally {
        run.setPhase("tearing_down");
        // Flush buffered log lines to the platform BEFORE marking the step as
        // failed. This guarantees the error output (postCreateCommand failure,
        // AWS errors, etc.) reaches the API while the step is still "running"
        // and assertClaimOwnership will accept the appends.
        await logStream.stop();
        if (executionError instanceof TaskRunCancelledError) {
          await heartbeat.stop();
        } else if (executionError !== undefined) {
          // The heartbeat runs until the failure is reported: runtime cleanup
          // can outlast the lease, and a lapsed lease would replace the real
          // error with "abandoned".
          try {
            await failClaimedTaskRunIfStillRunning(deps.workerClient, logger, {
              taskRunId: claim.task.id,
              claimToken: claim.claimToken,
              error: executionError,
            });
          } catch (failError: unknown) {
            // Best-effort: if the fail call itself errors (e.g. already failed
            // via the heartbeat expiry), don't mask the original execution error
            // — but log it explicitly. A silent swallow previously hid a
            // server-side rollback that left the step stuck "running" until its
            // lease lapsed (surfacing as "abandoned").
            logger.error("step", "Failed to report claimed step failure", {
              taskRunId: claim.task.id,
              errorMessage:
                failError instanceof Error
                  ? failError.message
                  : String(failError),
            });
          } finally {
            await heartbeat.stop();
          }
        }
      }
    },
  );

  logger.log("worker", "Claimed task added to active jobs", {
    projectId: input.projectId,
    workerId: input.workerId,
    taskRunId: claim.task.id,
    activeJobs: runs.count({ projectId: input.projectId }),
  });

  void (async () => {
    try {
      await job;
      totals.processedCount += 1;
      logger.log("worker", "Claimed task finished successfully", {
        projectId: input.projectId,
        workerId: input.workerId,
        taskRunId: claim.task.id,
        processedCount: totals.processedCount,
        activeJobsRemaining: runs.count({ projectId: input.projectId }),
      });
    } catch (error: unknown) {
      totals.skippedCount += 1;
      logger.error("worker", "Claimed task promise rejected", {
        projectId: input.projectId,
        workerId: input.workerId,
        taskRunId: claim.task.id,
        skippedCount: totals.skippedCount,
        activeJobsRemaining: runs.count({ projectId: input.projectId }),
        error,
      });
    }
  })();

  return job;
}

import { scheduleClaimedTaskRunJob } from "./schedule-claimed-task-runs";
import { ProjectSlots } from "./process-project-work-slots";
import {
  resolveProjectWorkLogger,
  resolveProjectWorkReporter,
} from "./process-project-work-logger";
import type {
  ProcessProjectWorkDeps,
  ProcessProjectWorkInput,
  ProcessProjectWorkResult,
} from "../contracts/process-project-work-types";
import { validateProcessProjectWorkInput } from "./validate-process-project-work-input";
import { RunRegistry } from "./run-registry";
import {
  nextPollIntervalMs,
  resolveMaxPollIntervalMs,
  sleepBeforeNextPoll,
} from "./process-project-work-idle";

function createWorkTotals() {
  return {
    claimedCount: 0,
    processedCount: 0,
    skippedCount: 0,
  };
}

type PollingContext = {
  tracker: ReturnType<ProcessProjectWorkDeps["createRunTracker"]>;
  totals: ReturnType<typeof createWorkTotals>;
  runs: RunRegistry;
  slots: ProjectSlots;
};

function countActiveJobs(input: ProcessProjectWorkInput, runs: RunRegistry) {
  return runs.count({ projectId: input.projectId });
}

async function claimTaskRuns(
  input: ProcessProjectWorkInput,
  deps: ProcessProjectWorkDeps,
  totals: ReturnType<typeof createWorkTotals>,
  batchSize: number,
) {
  const logger = resolveProjectWorkLogger(deps);

  logger.log("worker", "Claiming tasks", {
    projectId: input.projectId,
    workerId: input.workerId,
    batchSize,
    leaseDurationSeconds: input.leaseDurationSeconds,
  });
  const claims = await deps.workerClient.claimTaskRuns({
    projectId: input.projectId,
    workerId: input.workerId,
    batchSize,
    leaseDurationSeconds: input.leaseDurationSeconds,
    workItemId: input.readWorkItemId?.(),
  });
  totals.claimedCount += claims.length;

  logger.log("worker", "Claim tasks response received", {
    projectId: input.projectId,
    workerId: input.workerId,
    claimedCount: claims.length,
    totalClaimedCount: totals.claimedCount,
    taskRunIds: claims.map((claim) => claim.task.id),
  });

  if (claims.length > 0) {
    resolveProjectWorkReporter(deps).event({
      type: "worker:claimed",
      count: claims.length,
    });
  }

  return claims;
}

/**
 * Claims at most `reserved` runs, hands back the slots it did not use, and
 * schedules each claim so its slot is released when the run settles.
 */
async function pollForTaskRunClaims(
  input: ProcessProjectWorkInput,
  deps: ProcessProjectWorkDeps,
  context: PollingContext,
  reserved: number,
) {
  const { totals, runs, slots, tracker } = context;

  resolveProjectWorkLogger(deps).log("worker", "Polling for work", {
    projectId: input.projectId,
    workerId: input.workerId,
    activeJobs: countActiveJobs(input, runs),
    reservedSlots: reserved,
  });
  resolveProjectWorkReporter(deps).event({ type: "worker:polling" });

  let claims: Awaited<ReturnType<typeof claimTaskRuns>>;
  try {
    claims = await claimTaskRuns(input, deps, totals, reserved);
  } catch (error: unknown) {
    await slots.release(reserved);
    throw error;
  }
  await slots.release(reserved - claims.length);

  let scheduled = 0;
  try {
    for (const claim of claims) {
      const job = scheduleClaimedTaskRunJob(
        input,
        deps,
        claim,
        tracker,
        totals,
        runs,
      );
      scheduled += 1;
      slots.releaseWhenSettled(job, claim.task.id);
    }
  } finally {
    await slots.release(claims.length - scheduled);
  }
  return claims;
}

function logWorkerStart(
  input: ProcessProjectWorkInput,
  deps: ProcessProjectWorkDeps,
) {
  const logger = resolveProjectWorkLogger(deps);

  logger.log("worker", "Worker client ready", {
    projectId: input.projectId,
    userId: deps.workerClient.userId,
  });
  resolveProjectWorkReporter(deps).event({
    type: "worker:ready",
    workerId: input.workerId,
  });
  logger.log("worker", "Resolved worker configuration", {
    projectId: input.projectId,
    workerId: input.workerId,
    concurrency: input.concurrency,
    batchSize: input.batchSize,
    pollIntervalMs: input.pollIntervalMs,
    maxPollIntervalMs: resolveMaxPollIntervalMs(input),
    connectedMaxPollIntervalMs: input.connectedMaxPollIntervalMs,
    leaseDurationSeconds: input.leaseDurationSeconds,
    workItemId: input.readWorkItemId?.(),
    preserveRuntimeOnComplete: input.preserveRuntimeOnComplete ?? false,
    once: input.once ?? false,
  });
}

async function waitForActiveJobs(
  input: ProcessProjectWorkInput,
  deps: ProcessProjectWorkDeps,
  runs: RunRegistry,
) {
  const logger = resolveProjectWorkLogger(deps);

  logger.log("worker", "Waiting for active jobs to settle", {
    projectId: input.projectId,
    workerId: input.workerId,
    activeJobs: countActiveJobs(input, runs),
  });
  await Promise.allSettled(runs.jobs({ projectId: input.projectId }));
}

function buildResult(
  totals: ReturnType<typeof createWorkTotals>,
): ProcessProjectWorkResult {
  return {
    claimedCount: totals.claimedCount,
    processedCount: totals.processedCount,
    skippedCount: totals.skippedCount,
  };
}

function logWorkerComplete(
  input: ProcessProjectWorkInput,
  deps: ProcessProjectWorkDeps,
  totals: ReturnType<typeof createWorkTotals>,
) {
  const logger = resolveProjectWorkLogger(deps);

  logger.log("worker", "Worker run complete", {
    projectId: input.projectId,
    workerId: input.workerId,
    claimedCount: totals.claimedCount,
    processedCount: totals.processedCount,
    skippedCount: totals.skippedCount,
  });
  resolveProjectWorkReporter(deps).event({
    type: "worker:complete",
    processed: totals.processedCount,
    skipped: totals.skippedCount,
  });
}

async function closeRunTracker(
  input: ProcessProjectWorkInput,
  deps: ProcessProjectWorkDeps,
  tracker: ReturnType<ProcessProjectWorkDeps["createRunTracker"]>,
) {
  const logger = resolveProjectWorkLogger(deps);

  logger.log("worker", "Closing run tracker", {
    projectId: input.projectId,
    workerId: input.workerId,
  });
  await tracker.close();
  logger.log("worker", "Run tracker closed", {
    projectId: input.projectId,
    workerId: input.workerId,
  });
}

function isDraining(input: ProcessProjectWorkInput) {
  return input.drainSignal?.aborted === true;
}

async function waitForFreeSlots(
  input: ProcessProjectWorkInput,
  deps: ProcessProjectWorkDeps,
  context: PollingContext,
) {
  resolveProjectWorkLogger(deps).log(
    "worker",
    "Skipping polling for work because no run slots are free. Waiting for slots to be released.",
    {
      projectId: input.projectId,
      workerId: input.workerId,
      activeJobs: countActiveJobs(input, context.runs),
    },
  );
  await context.slots.waitForChange();
}

async function runPollingLoop(
  input: ProcessProjectWorkInput,
  deps: ProcessProjectWorkDeps,
  context: PollingContext,
) {
  const { runs } = context;
  const logger = resolveProjectWorkLogger(deps);
  let currentPollIntervalMs = input.pollIntervalMs;

  for (;;) {
    if (isDraining(input)) {
      logger.log("worker", "Draining; no longer taking new work", {
        projectId: input.projectId,
        workerId: input.workerId,
        activeJobs: countActiveJobs(input, runs),
      });
      return;
    }

    const reserved = await context.slots.acquireBatch();
    if (reserved === 0) {
      await waitForFreeSlots(input, deps, context);
      continue;
    }

    const claims = await pollForTaskRunClaims(input, deps, context, reserved);

    currentPollIntervalMs = nextPollIntervalMs(
      input,
      deps,
      currentPollIntervalMs,
      claims.length,
    );

    if (input.once === true) {
      logger.log("worker", "Single-pass mode enabled; exiting poll loop", {
        projectId: input.projectId,
        workerId: input.workerId,
      });
      return;
    }

    if (await sleepBeforeNextPoll(input, deps, currentPollIntervalMs)) {
      currentPollIntervalMs = input.pollIntervalMs;
    }
  }
}

export async function processProjectWork(
  input: ProcessProjectWorkInput,
  deps: ProcessProjectWorkDeps,
): Promise<ProcessProjectWorkResult> {
  validateProcessProjectWorkInput(input);

  const logger = resolveProjectWorkLogger(deps);
  resolveProjectWorkReporter(deps).event({
    type: "worker:starting",
    projectId: input.projectId,
    concurrency: input.concurrency,
  });
  logger.log("worker", "Creating run tracker", {
    projectId: input.projectId,
    workerId: input.workerId,
  });

  const tracker = deps.createRunTracker();
  const totals = createWorkTotals();
  const runs = input.runRegistry ?? new RunRegistry();
  const slots = new ProjectSlots(input, deps);

  logWorkerStart(input, deps);

  let loopError: { error: unknown } | null = null;
  try {
    await runPollingLoop(input, deps, { tracker, totals, runs, slots });
  } catch (error: unknown) {
    loopError = { error };
    input.onLoopError?.(error);
  }

  try {
    await waitForActiveJobs(input, deps, runs);
    await slots.settled();
    if (loopError) throw loopError.error;
    logWorkerComplete(input, deps, totals);
    return buildResult(totals);
  } finally {
    await closeRunTracker(input, deps, tracker);
  }
}

export type {
  ProcessProjectWorkDeps,
  ProcessProjectWorkInput,
  ProcessProjectWorkResult,
  ProjectWorkLogger,
  TaskAgentRunner,
  TaskRunTracker,
  TaskRuntimeEnvironment,
  TaskRuntimeEnvironmentOrchestrator,
  TaskRunWorkerClaim,
  TaskRunWorkerClient,
  TaskRunWorkerContext,
} from "../contracts/process-project-work-types";

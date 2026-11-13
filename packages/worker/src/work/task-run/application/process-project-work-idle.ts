/**
 * The polling loop's idle backoff and the sleep between polls, which a push
 * wake-up, a socket disconnect or a drain can cut short.
 */
import { abortedOrNever } from "./run-registry";
import {
  resolveProjectWorkLogger,
  resolveProjectWorkReporter,
} from "./process-project-work-logger";
import type {
  ProcessProjectWorkDeps,
  ProcessProjectWorkInput,
  WorkSignalConnection,
} from "../contracts/process-project-work-types";

const POLL_BACKOFF_MULTIPLIER = 2;

export function resolveMaxPollIntervalMs(input: ProcessProjectWorkInput) {
  return Math.max(
    input.pollIntervalMs,
    input.maxPollIntervalMs ?? input.pollIntervalMs,
  );
}

function resolveEffectiveMaxPollIntervalMs(
  input: ProcessProjectWorkInput,
  deps: ProcessProjectWorkDeps,
) {
  const maxPollIntervalMs = resolveMaxPollIntervalMs(input);

  if (!deps.signalConnection?.isConnected()) {
    return maxPollIntervalMs;
  }

  return Math.max(
    maxPollIntervalMs,
    input.connectedMaxPollIntervalMs ?? maxPollIntervalMs,
  );
}

export function nextPollIntervalMs(
  input: ProcessProjectWorkInput,
  deps: ProcessProjectWorkDeps,
  currentPollIntervalMs: number,
  claimedCount: number,
) {
  if (claimedCount > 0) {
    return input.pollIntervalMs;
  }

  if (deps.signalConnection?.isConnected()) {
    return resolveEffectiveMaxPollIntervalMs(input, deps);
  }

  return Math.min(
    resolveEffectiveMaxPollIntervalMs(input, deps),
    currentPollIntervalMs * POLL_BACKOFF_MULTIPLIER,
  );
}

type IdleOutcome = "slept" | "woken" | "disconnected" | "drained";

async function idleFor(
  deps: ProcessProjectWorkDeps,
  milliseconds: number,
  drainSignal: AbortSignal | undefined,
  connection?: WorkSignalConnection,
): Promise<IdleOutcome> {
  if (drainSignal?.aborted) {
    return "drained";
  }
  if (!deps.wake && !connection && !drainSignal) {
    await deps.sleep(milliseconds);
    return "slept";
  }

  const loser = new AbortController();
  const racers: Promise<IdleOutcome>[] = [
    deps.sleep(milliseconds, loser.signal).then(() => "slept" as const),
  ];
  if (deps.wake) {
    racers.push(deps.wake(loser.signal).then(() => "woken" as const));
  }
  if (connection) {
    racers.push(
      connection.disconnected(loser.signal).then(() => "disconnected" as const),
    );
  }
  if (drainSignal) {
    racers.push(
      abortedOrNever(drainSignal, loser.signal).then(() => "drained" as const),
    );
  }

  try {
    return await Promise.race(racers);
  } finally {
    loser.abort();
  }
}

export async function sleepBeforeNextPoll(
  input: ProcessProjectWorkInput,
  deps: ProcessProjectWorkDeps,
  pollIntervalMs: number,
) {
  const logger = resolveProjectWorkLogger(deps);

  logger.log("worker", "Sleeping before next poll", {
    projectId: input.projectId,
    workerId: input.workerId,
    pollIntervalMs,
  });
  resolveProjectWorkReporter(deps).event({
    type: "worker:idle",
    pollIntervalMs,
  });

  const maxPollIntervalMs = resolveMaxPollIntervalMs(input);
  const now = deps.now ?? Date.now;
  const startedAt = now();
  let outcome = await idleFor(
    deps,
    pollIntervalMs,
    input.drainSignal,
    pollIntervalMs > maxPollIntervalMs ? deps.signalConnection : undefined,
  );

  if (outcome === "disconnected") {
    const remainingMs = Math.max(0, maxPollIntervalMs - (now() - startedAt));
    logger.log("worker", "Work signal disconnected; shortening idle sleep", {
      projectId: input.projectId,
      workerId: input.workerId,
      remainingMs,
    });
    outcome =
      remainingMs > 0
        ? await idleFor(deps, remainingMs, input.drainSignal)
        : "slept";
  }

  const woken = outcome === "woken";

  if (woken) {
    logger.log("worker", "Woken by work signal; polling now", {
      projectId: input.projectId,
      workerId: input.workerId,
    });
  }

  return woken;
}

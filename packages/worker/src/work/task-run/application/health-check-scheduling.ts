/**
 * The phase and lane scheduling every health check runner shares: the
 * OpenCode-driven one (`run-health-checks.ts`) and the direct one a code step
 * uses (`run-direct-mcp-health-checks.ts`). A runner supplies how to run one
 * check; this module decides the order.
 *
 * Two phases run in strict order: every `required` check, then every `warn`
 * check. A `warn` failure never aborts anything, since `warn` exists to be
 * advisory (see `healthCheckSeverityValues`).
 *
 * Within a phase, checks run in parallel by default: each check is its own
 * lane. Checks sharing a `serialGroup` value form one lane and run one at a
 * time, in declaration order, while still running concurrently with every
 * other lane. A `serialGroup` shared between a `required` and a `warn` check
 * is never a concurrency concern, since the phases are separated by a full
 * `await`.
 *
 * A `required` failure sets a shared abort flag every lane checks before
 * starting its next check. This is best-effort, not a hard stop: a check
 * already in flight when the flag flips is not cancelled and keeps its real
 * outcome; only checks that haven't started yet get `skipped`. If the
 * `required` phase ends with the flag set, the whole `warn` phase is skipped
 * without attempting a single check.
 */
import type { HealthCheck } from "@scarn/sdk/health-checks";
import type { HealthCheckOutcome } from "./run-health-checks";

export type RunOneHealthCheck = (
  check: HealthCheck,
) => Promise<HealthCheckOutcome>;

type IndexedCheck = { check: HealthCheck; index: number };

type AbortFlag = { aborted: boolean };

export type ScheduledHealthCheck = {
  check: HealthCheck;
  outcome: HealthCheckOutcome;
};

/**
 * Runs `healthChecks` with `runOne` under the phase and lane rules above and
 * returns each check with its outcome, in the same order as `healthChecks`.
 */
export async function scheduleHealthChecks(
  healthChecks: readonly HealthCheck[],
  runOne: RunOneHealthCheck,
): Promise<ScheduledHealthCheck[]> {
  const indexed = healthChecks.map((check, index) => ({ check, index }));
  const outcomeByIndex = new Map<number, HealthCheckOutcome>();
  const abort: AbortFlag = { aborted: false };

  await runPhase(
    indexed.filter(({ check }) => check.severity === "required"),
    runOne,
    abort,
    outcomeByIndex,
  );
  await runPhase(
    indexed.filter(({ check }) => check.severity === "warn"),
    runOne,
    abort,
    outcomeByIndex,
  );

  return healthChecks.map((check, index) => {
    const outcome = outcomeByIndex.get(index);
    if (!outcome) {
      throw new Error(
        `Internal error: the health check runner produced no outcome for index ${String(index)}`,
      );
    }
    return { check, outcome };
  });
}

async function runPhase(
  entries: IndexedCheck[],
  runOne: RunOneHealthCheck,
  abort: AbortFlag,
  outcomeByIndex: Map<number, HealthCheckOutcome>,
): Promise<void> {
  const groups = new Map<string, IndexedCheck[]>();
  const lanes: IndexedCheck[][] = [];

  for (const entry of entries) {
    const key = entry.check.serialGroup;
    if (key === undefined) {
      lanes.push([entry]);
      continue;
    }
    const group = groups.get(key);
    if (group) {
      group.push(entry);
    } else {
      const newGroup = [entry];
      groups.set(key, newGroup);
      lanes.push(newGroup);
    }
  }

  await Promise.all(
    lanes.map((lane) => runLane(lane, runOne, abort, outcomeByIndex)),
  );
}

async function runLane(
  lane: IndexedCheck[],
  runOne: RunOneHealthCheck,
  abort: AbortFlag,
  outcomeByIndex: Map<number, HealthCheckOutcome>,
): Promise<void> {
  for (const { check, index } of lane) {
    if (abort.aborted) {
      outcomeByIndex.set(index, { kind: "skipped" });
      continue;
    }
    const outcome = await runOne(check);
    outcomeByIndex.set(index, outcome);
    if (outcome.kind === "failed" && check.severity === "required") {
      abort.aborted = true;
    }
  }
}

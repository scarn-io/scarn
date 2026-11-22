/**
 * Self-hosted scheduler: a long-running process that POSTs the API's
 * maintenance routes on the schedules in `jobs.ts`, replacing the hosted
 * deploy's EventBridge rules. Run it next to the API (`bun run
 * src/scheduler/run.ts`) with `SCARN_API_URL` pointing at it and the same
 * `*_CRON_SECRET` values the API has. Jobs whose secret is unset are skipped.
 */
import { SCHEDULER_REQUIRED_ENV, assertRequiredEnv } from "../required-env";
import { nextRunAt, planJobs, triggerJob, type ScheduledJob } from "./jobs";

const env = process.env;

try {
  assertRequiredEnv(SCHEDULER_REQUIRED_ENV, "[scheduler]", env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const apiUrl = env["SCARN_API_URL"]?.trim() || "http://localhost:3001";

const runJob = async (job: ScheduledJob): Promise<void> => {
  const startedAt = Date.now();
  try {
    const result = await triggerJob(job, { apiUrl, env });
    const elapsed = `${String(Date.now() - startedAt)}ms`;
    if (result.ok) {
      console.warn(
        `[scheduler] ${job.name}: ${String(result.status)} in ${elapsed}`,
      );
    } else {
      console.error(
        `[scheduler] ${job.name}: ${String(result.status)} in ${elapsed}: ${result.body.slice(0, 500)}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[scheduler] ${job.name}: request failed: ${message}`);
  }
};

const plan = planJobs(env);

for (const { job, reason } of plan.skipped) {
  console.warn(`[scheduler] skipping ${job.name}: ${reason}`);
}

if (plan.active.length === 0) {
  console.error(
    "[scheduler] no jobs configured; set the *_CRON_SECRET variables",
  );
  process.exit(1);
}

for (const job of plan.active) {
  for (const schedule of job.schedules) {
    Bun.cron(schedule, () => runJob(job), { tz: "UTC" });
  }
  const next = nextRunAt(job, new Date());
  console.warn(
    `[scheduler] ${job.name}: POST ${job.path} on "${job.schedules.join('" and "')}" UTC, next ${next?.toISOString() ?? "never"}`,
  );
}

console.warn(`[scheduler] calling ${apiUrl}`);

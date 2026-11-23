/**
 * Scheduled maintenance jobs for self-hosted installs.
 *
 * The hosted deploy triggers these routes from AWS EventBridge
 * (`infra/*-schedule.tf`); a self-hosted install runs `run.ts` instead, which
 * POSTs the same routes with the same bearer secrets. Keep this table in sync
 * with the EventBridge rules: `jobs.test.ts` fails when `infra/` has a target
 * missing here.
 *
 * Schedules are 5-field cron expressions evaluated in UTC. They follow the
 * hosted defaults where cron can express them; "every N days" rates become
 * fixed days of the month.
 */

type Env = Record<string, string | undefined>;

export type ScheduledJob = {
  name: string;
  path: string;
  schedules: readonly string[];
  secretEnv: string;
  isEnabled?: (env: Env) => boolean;
};

export const isDemoProjectEnabled = (env: Env): boolean => {
  const raw = env["SCARN_DEMO_PROJECT"]?.trim().toLowerCase();
  return raw === "true" || raw === "1";
};

export const scheduledJobs: readonly ScheduledJob[] = [
  {
    name: "reconcile-storage",
    path: "/api/internal/usage/reconcile-storage",
    schedules: ["0 8 * * *"],
    secretEnv: "RECONCILE_CRON_SECRET",
  },
  {
    name: "purge-abandoned-logs",
    path: "/api/internal/executions/purge-abandoned-logs",
    schedules: ["30 8 * * *"],
    secretEnv: "RECONCILE_CRON_SECRET",
  },
  {
    name: "sweep-deleted-storage",
    path: "/api/internal/executions/sweep-deleted-storage",
    schedules: ["0 9 * * *"],
    secretEnv: "RECONCILE_CRON_SECRET",
  },
  {
    name: "managed-connections-sweep",
    path: "/api/internal/connections/sweep",
    schedules: ["30 9 * * *"],
    secretEnv: "RECONCILE_CRON_SECRET",
  },
  {
    name: "github-reconcile",
    path: "/api/internal/integrations/reconcile",
    schedules: ["0 10 * * *"],
    secretEnv: "GITHUB_RECONCILE_CRON_SECRET",
  },
  {
    name: "integration-poll",
    path: "/api/internal/integrations/poll",
    schedules: ["*/10 13-23 * * *", "0 0-12 * * *"],
    secretEnv: "INTEGRATION_POLL_CRON_SECRET",
  },
  {
    name: "automation-schedule-tick",
    path: "/api/internal/automations/schedules/tick",
    schedules: ["* * * * *"],
    secretEnv: "AUTOMATION_SCHEDULE_TICK_CRON_SECRET",
  },
  {
    name: "demo-project-refresh",
    path: "/api/internal/demo-project/refresh",
    schedules: ["0 4 1,15 * *"],
    secretEnv: "DEMO_PROJECT_REFRESH_CRON_SECRET",
    isEnabled: isDemoProjectEnabled,
  },
];

export type JobPlan = {
  active: ScheduledJob[];
  skipped: { job: ScheduledJob; reason: string }[];
};

/** Splits the job table into jobs to run and jobs skipped for missing config. */
export const planJobs = (
  env: Env,
  jobs: readonly ScheduledJob[] = scheduledJobs,
): JobPlan => {
  const plan: JobPlan = { active: [], skipped: [] };
  for (const job of jobs) {
    if (job.isEnabled && !job.isEnabled(env)) {
      plan.skipped.push({ job, reason: "disabled by configuration" });
    } else if (!env[job.secretEnv]?.trim()) {
      plan.skipped.push({ job, reason: `${job.secretEnv} is not set` });
    } else {
      plan.active.push(job);
    }
  }
  return plan;
};

/** The earliest time after `from` at which any of the job's schedules fires (UTC). */
export const nextRunAt = (job: ScheduledJob, from: Date): Date | null => {
  let earliest: Date | null = null;
  for (const schedule of job.schedules) {
    const next = Bun.cron.parse(schedule, from, { tz: "UTC" });
    if (next && (!earliest || next < earliest)) earliest = next;
  }
  return earliest;
};

export type JobResult = { ok: boolean; status: number; body: string };

/** POSTs a job's route on the API with its bearer secret. */
export const triggerJob = async (
  job: ScheduledJob,
  {
    apiUrl,
    env,
    fetchFn = fetch,
  }: { apiUrl: string; env: Env; fetchFn?: typeof fetch },
): Promise<JobResult> => {
  const response = await fetchFn(new URL(job.path, apiUrl), {
    method: "POST",
    headers: { Authorization: `Bearer ${env[job.secretEnv] ?? ""}` },
  });
  return {
    ok: response.ok,
    status: response.status,
    body: await response.text(),
  };
};

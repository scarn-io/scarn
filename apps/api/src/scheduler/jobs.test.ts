import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { nextRunAt, planJobs, scheduledJobs, triggerJob } from "./jobs";

const infraDir = resolve(import.meta.dir, "../../../../infra");

const allSecrets = Object.fromEntries(
  scheduledJobs.map((job) => [job.secretEnv, "secret"]),
);

describe("scheduledJobs", () => {
  test("every job has a unique name and an internal API path", () => {
    const names = scheduledJobs.map((job) => job.name);
    expect(new Set(names).size).toBe(names.length);
    for (const job of scheduledJobs) {
      expect(job.path).toStartWith("/api/internal/");
      expect(job.schedules.length).toBeGreaterThan(0);
    }
  });

  test("every schedule is a valid cron expression", () => {
    for (const job of scheduledJobs) {
      expect(nextRunAt(job, new Date())).toBeInstanceOf(Date);
    }
  });
});

describe("planJobs", () => {
  test("runs every job except the demo refresh when all secrets are set", () => {
    const plan = planJobs(allSecrets);
    expect(plan.active.map((job) => job.name)).not.toContain(
      "demo-project-refresh",
    );
    expect(plan.active).toHaveLength(scheduledJobs.length - 1);
    expect(plan.skipped.map(({ job, reason }) => [job.name, reason])).toEqual([
      ["demo-project-refresh", "disabled by configuration"],
    ]);
  });

  test("runs the demo refresh when the demo project is enabled", () => {
    const plan = planJobs({ ...allSecrets, SCARN_DEMO_PROJECT: "true" });
    expect(plan.active).toHaveLength(scheduledJobs.length);
  });

  test("skips jobs whose secret is unset or blank", () => {
    const plan = planJobs({
      RECONCILE_CRON_SECRET: "secret",
      GITHUB_RECONCILE_CRON_SECRET: " ",
    });
    expect(plan.active.map((job) => job.name)).toEqual([
      "reconcile-storage",
      "purge-abandoned-logs",
      "sweep-deleted-storage",
      "managed-connections-sweep",
    ]);
    expect(
      plan.skipped.find((entry) => entry.job.name === "github-reconcile")
        ?.reason,
    ).toBe("GITHUB_RECONCILE_CRON_SECRET is not set");
  });
});

describe("nextRunAt", () => {
  const job = (schedules: string[]) => ({
    name: "test",
    path: "/api/internal/test",
    secretEnv: "SECRET",
    schedules,
  });

  test("computes the next daily run in UTC", () => {
    expect(
      nextRunAt(job(["30 8 * * *"]), new Date("2026-01-01T09:00:00Z")),
    ).toEqual(new Date("2026-01-02T08:30:00Z"));
  });

  test("picks the earliest of several schedules", () => {
    const poll = job(["*/10 13-23 * * *", "0 0-12 * * *"]);
    expect(nextRunAt(poll, new Date("2026-01-01T12:30:00Z"))).toEqual(
      new Date("2026-01-01T13:00:00Z"),
    );
    expect(nextRunAt(poll, new Date("2026-01-01T23:55:00Z"))).toEqual(
      new Date("2026-01-02T00:00:00Z"),
    );
    expect(nextRunAt(poll, new Date("2026-01-01T15:01:00Z"))).toEqual(
      new Date("2026-01-01T15:10:00Z"),
    );
  });
});

describe("triggerJob", () => {
  test("POSTs the job path on the API with its bearer secret", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchFn = ((url: URL, init?: RequestInit) => {
      calls.push({ url: url.href, init });
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch;
    const [job] = scheduledJobs;
    if (!job) throw new Error("no jobs");

    const result = await triggerJob(job, {
      apiUrl: "http://api:3001",
      env: { [job.secretEnv]: "s3cret" },
      fetchFn,
    });

    expect(result).toEqual({ ok: true, status: 200, body: "{}" });
    expect(calls).toEqual([
      {
        url: `http://api:3001${job.path}`,
        init: { method: "POST", headers: { Authorization: "Bearer s3cret" } },
      },
    ]);
  });
});

describe.skipIf(!existsSync(infraDir))("sync with infra/*-schedule.tf", () => {
  test("every EventBridge target path has a scheduled job", () => {
    const mainTf = readFileSync(join(infraDir, "main.tf"), "utf-8");
    const scheduleFiles = readdirSync(infraDir).filter((file) =>
      file.endsWith("-schedule.tf"),
    );
    expect(scheduleFiles.length).toBeGreaterThan(0);

    const jobPaths = scheduledJobs.map((job) => job.path);
    for (const file of scheduleFiles) {
      const source = readFileSync(join(infraDir, file), "utf-8");
      const endpointVars = [
        ...source.matchAll(/invocation_endpoint\s*=\s*var\.(\w+)/g),
      ].map((match) => match[1]);
      expect(endpointVars.length).toBeGreaterThan(0);

      for (const variable of endpointVars) {
        const block = new RegExp(
          `variable "${variable ?? ""}"\\s*\\{[^}]*?POST (/api/internal/[\\w/-]+)`,
        ).exec(mainTf);
        const path = block?.[1] ?? "";
        expect(
          path,
          `${file}: no POST path for var.${variable ?? ""}`,
        ).not.toBe("");
        expect(
          jobPaths,
          `${file}: ${path} missing from scheduledJobs`,
        ).toContain(path);
      }
    }
  });
});

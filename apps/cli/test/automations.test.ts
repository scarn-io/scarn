import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasReporterLine, runCli } from "./utils";

// Spawns the CLI from source; under a loaded machine (test-all-workspaces)
// that overruns bun's 5s default.
setDefaultTimeout(15_000);

const PROJECT_ID = "0196a000-0000-7000-8000-000000000001";
const WORK_ITEM_ID = "0196a000-0000-7000-8000-0000000000aa";
const TICKET_URL = "https://github.com/acme/app/issues/7";
const RUN_TASK_ID = "0196a000-0000-7000-8000-0000000000b1";
const HELD_TASK_ID = "0196a000-0000-7000-8000-0000000000b2";

type Request = { method: string; path: string };

const automation = (key: string, enabled: boolean) => ({
  id: `auto-${key}`,
  projectId: PROJECT_ID,
  key,
  title: key,
  scope: key === "wayfinder" ? "workItem" : "project",
  enabled,
  latestVersion: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
});

const json = (body: object, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Just enough of the API for the automations commands. */
function handle(request: Request, url: URL): Response {
  const { method, path } = request;
  if (path === "/api/auth/get-session") {
    return json({
      session: { id: "s", userId: "u", expiresAt: "2099-01-01T00:00:00Z" },
      user: { id: "u", email: "dev@example.com", name: "Dev" },
    });
  }
  if (path === "/api/projects/resolve") {
    return json({ id: PROJECT_ID });
  }
  if (path === `/api/projects/${PROJECT_ID}/work-items`) {
    return json({
      items:
        url.searchParams.get("q") === TICKET_URL
          ? [
              {
                id: WORK_ITEM_ID,
                title: "Bug",
                description: "",
                platform: "github",
                url: TICKET_URL,
              },
            ]
          : [],
      total: 0,
      page: 1,
      pageSize: 15,
    });
  }
  if (method === "GET" && path === `/api/projects/${PROJECT_ID}/automations`) {
    return json([
      {
        ...automation("nightly", true),
        schedules: [
          {
            id: "0196a000-0000-7000-8000-0000000000c1",
            key: "sweep",
            cron: "0 2 * * *",
            timezone: "Europe/London",
            concurrency: { max: 1, waiting: 0 },
            nextRunAt: "2026-11-23T02:00:00.000Z",
            lastFiredAt: "2026-11-22T02:00:00.000Z",
            lastTask: {
              id: RUN_TASK_ID,
              status: "failed",
              scheduledFor: "2026-11-22T02:00:00.000Z",
            },
            failureStreak: 2,
            lastSkippedAt: "2026-11-21T02:00:00.000Z",
            skippedCountSinceFire: 0,
            lastError: {
              message: `Step "sweep" is gone\n${"x".repeat(200)}`,
              at: "2026-11-20T02:00:00.000Z",
            },
          },
        ],
      },
      {
        ...automation("weekly", false),
        schedules: [
          {
            id: "0196a000-0000-7000-8000-0000000000c2",
            key: "digest",
            cron: "0 9 * * 1",
            timezone: "UTC",
            concurrency: { max: 1, waiting: 0 },
            nextRunAt: null,
            lastFiredAt: null,
            lastTask: null,
            failureStreak: 0,
            lastSkippedAt: null,
            skippedCountSinceFire: 0,
            lastError: null,
          },
        ],
      },
      { ...automation("wayfinder", false), schedules: [] },
    ]);
  }
  const toggle =
    /^\/api\/projects\/[^/]+\/automations\/([^/]+)\/(enable|disable)$/.exec(
      path,
    );
  if (method === "POST" && toggle) {
    const key = toggle[1] ?? "";
    if (key === "wayfinder") {
      return json(
        {
          type: "about:blank",
          title: "Bad request",
          status: 400,
          detail: `Automation 'wayfinder' is a work-item automation; attach it to a work item instead`,
          code: "AUTOMATION_NOT_PROJECT_SCOPE",
        },
        400,
      );
    }
    return json(automation(key, toggle[2] === "enable"));
  }
  const scheduleRun =
    /^\/api\/projects\/[^/]+\/automations\/([^/]+)\/schedules\/([^/]+)\/runs$/.exec(
      path,
    );
  if (method === "POST" && scheduleRun) {
    const ruleKey = scheduleRun[2] ?? "";
    if (ruleKey === "busy") {
      return json(
        {
          type: "about:blank",
          title: "Conflict",
          status: 409,
          detail: "The concurrency group of schedule s1 is full",
          code: "Scarn.ConcurrencyGroupFull",
          meta: { scheduleId: "s1", heldBy: [HELD_TASK_ID] },
        },
        409,
      );
    }
    return json(
      {
        taskId: ruleKey === "quiet" ? null : RUN_TASK_ID,
        scheduledFor: "2026-11-22T12:00:00.000Z",
      },
      201,
    );
  }
  const workItem = /^\/api\/work-items\/([^/]+)\/automations\/([^/]+)$/.exec(
    path,
  );
  if (workItem) {
    const key = workItem[2] ?? "";
    if (method === "POST") {
      return json({
        workItemId: workItem[1],
        automation: automation(key, true),
        attachedAt: "2026-11-01T00:00:00.000Z",
      });
    }
    if (method === "DELETE") return json({ detached: true });
  }
  return json({ title: "Not found", status: 404, type: "about:blank" }, 404);
}

describe("scarn automations", () => {
  let server: ReturnType<typeof Bun.serve>;
  let home: string;
  let baseUrl: string;
  const requests: Request[] = [];

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        const request = { method: req.method, path: url.pathname };
        requests.push(request);
        return handle(request, url);
      },
    });
    baseUrl = `http://localhost:${String(server.port)}`;
    home = mkdtempSync(join(tmpdir(), "scarn-automations-home-"));
    mkdirSync(join(home, ".scarn"));
    writeFileSync(
      join(home, ".scarn", "auth.jsonc"),
      JSON.stringify({ profiles: { [baseUrl]: { accessToken: "tok" } } }),
    );
  });

  afterAll(() => {
    void server.stop(true);
    rmSync(home, { recursive: true, force: true });
  });

  const run = (args: string[]) => {
    requests.length = 0;
    return runCli(["automations", ...args, "--base-url", baseUrl], {
      cwd: home,
      env: { HOME: home, SCARN_TELEMETRY_DISABLED: "1" },
    });
  };
  const writes = () =>
    requests
      .filter((r) => r.method !== "GET")
      .map((r) => `${r.method} ${r.path}`);

  test("--help lists every subcommand", async () => {
    const result = await runCli(["automations", "--help"]);

    expect(result.exitCode).toBe(0);
    for (const command of [
      "list",
      "attach",
      "detach",
      "enable",
      "disable",
      "run",
    ]) {
      expect(result.stdout).toContain(`scarn automations ${command}`);
    }
  });

  test("list shows each schedule's next run, last Task, streak, skip and error", async () => {
    const result = await run(["list", "--project", "acme/app"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      [
        "Automations (3)",
        "  nightly  enabled  unpublished",
        "    schedule sweep  0 2 * * * (Europe/London)  next 2026-11-23T02:00:00.000Z",
        `      last fired 2026-11-22T02:00:00.000Z  last Task failed (${RUN_TASK_ID})  2 failed in a row`,
        "      last skipped 2026-11-21T02:00:00.000Z (0 since the last fire)",
        `      last error 2026-11-20T02:00:00.000Z: Step "sweep" is gone ${"x".repeat(98)}…`,
        "  weekly  disabled  unpublished",
        "    schedule digest  0 9 * * 1 (UTC)  disabled",
        "      last fired never  no Tasks yet",
        "  wayfinder  work-item  unpublished",
        "",
      ].join("\n"),
    );
  });

  test("list --json prints the API's automations with their schedules", async () => {
    const result = await run(["list", "--project", "acme/app", "--json"]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      key: string;
      schedules: { key: string; failureStreak: number }[];
    }[];
    expect(
      parsed.map((entry) => [
        entry.key,
        entry.schedules.map((schedule) => schedule.failureStreak),
      ]),
    ).toEqual([
      ["nightly", [2]],
      ["weekly", [0]],
      ["wayfinder", []],
    ]);
  });

  test("enable turns on a project automation", async () => {
    const result = await run(["enable", "triage", "--project", "acme/app"]);

    expect(result.exitCode).toBe(0);
    expect(writes()).toEqual([
      `POST /api/projects/${PROJECT_ID}/automations/triage/enable`,
    ]);
    expect(hasReporterLine(result.stderr, `"triage" is enabled`)).toBe(true);
  });

  test("disable turns off a project automation", async () => {
    const result = await run(["disable", "triage", "--project", "acme/app"]);

    expect(result.exitCode).toBe(0);
    expect(writes()).toEqual([
      `POST /api/projects/${PROJECT_ID}/automations/triage/disable`,
    ]);
    expect(hasReporterLine(result.stderr, `"triage" is disabled.`)).toBe(true);
  });

  test("enable reports the server's reason for a work-item automation", async () => {
    const result = await run(["enable", "wayfinder", "--project", "acme/app"]);

    expect(result.exitCode).toBe(1);
    expect(
      hasReporterLine(
        result.stderr,
        `Could not enable "wayfinder": Automation 'wayfinder' is a work-item automation`,
      ),
    ).toBe(true);
  });

  test("run starts the schedule now and names the Task", async () => {
    const result = await run([
      "run",
      "nightly",
      "sweep",
      "--project",
      "acme/app",
    ]);

    expect(result.exitCode).toBe(0);
    expect(writes()).toEqual([
      `POST /api/projects/${PROJECT_ID}/automations/nightly/schedules/sweep/runs`,
    ]);
    expect(
      hasReporterLine(
        result.stderr,
        `Ran "nightly" schedule "sweep" for 2026-11-22T12:00:00.000Z: started Task ${RUN_TASK_ID}.`,
      ),
    ).toBe(true);
    expect(
      hasReporterLine(result.stderr, `scarn tasks view ${RUN_TASK_ID}`),
    ).toBe(true);
  });

  test("run reports a rule that routed to skip", async () => {
    const result = await run([
      "run",
      "nightly",
      "quiet",
      "--project",
      "acme/app",
    ]);

    expect(result.exitCode).toBe(0);
    expect(
      hasReporterLine(
        result.stderr,
        "the rule routed to skip, so no Task started.",
      ),
    ).toBe(true);
  });

  test("run names the open Task when the concurrency group is full", async () => {
    const result = await run([
      "run",
      "nightly",
      "busy",
      "--project",
      "acme/app",
    ]);

    expect(result.exitCode).toBe(1);
    expect(
      hasReporterLine(
        result.stderr,
        `Could not run "nightly" schedule "busy": a run is already open (held by Task ${HELD_TASK_ID})`,
      ),
    ).toBe(true);
  });

  test("attach takes a work item id without resolving the project", async () => {
    const result = await run(["attach", WORK_ITEM_ID, "wayfinder"]);

    expect(result.exitCode).toBe(0);
    expect(requests.some((r) => r.path === "/api/projects/resolve")).toBe(
      false,
    );
    expect(writes()).toEqual([
      `POST /api/work-items/${WORK_ITEM_ID}/automations/wayfinder`,
    ]);
    expect(
      hasReporterLine(
        result.stderr,
        `Attached "wayfinder" to work item ${WORK_ITEM_ID}.`,
      ),
    ).toBe(true);
  });

  test("attach resolves a ticket URL in the project", async () => {
    const result = await run([
      "attach",
      TICKET_URL,
      "wayfinder",
      "--project",
      "acme/app",
    ]);

    expect(result.exitCode).toBe(0);
    expect(writes()).toEqual([
      `POST /api/work-items/${WORK_ITEM_ID}/automations/wayfinder`,
    ]);
  });

  test("detach removes the automation from the work item", async () => {
    const result = await run(["detach", WORK_ITEM_ID, "wayfinder"]);

    expect(result.exitCode).toBe(0);
    expect(writes()).toEqual([
      `DELETE /api/work-items/${WORK_ITEM_ID}/automations/wayfinder`,
    ]);
    expect(
      hasReporterLine(
        result.stderr,
        `Detached "wayfinder" from work item ${WORK_ITEM_ID}.`,
      ),
    ).toBe(true);
  });

  test("attach rejects something that is neither an id nor a URL", async () => {
    const result = await run(["attach", "not an id", "wayfinder"]);

    expect(result.exitCode).toBe(1);
    expect(hasReporterLine(result.stderr, "is not a work item")).toBe(true);
    expect(writes()).toEqual([]);
  });
});

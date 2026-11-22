import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fixedTimeProvider } from "tests/utils";
import { holdDemoProjectTestLock } from "../demo-project-test-lock";

holdDemoProjectTestLock();

/**
 * Integration coverage for the scheduled maintenance endpoint
 * `POST /api/internal/demo-project/refresh`. Guarded by
 * `createServiceAuthenticated` against the dedicated
 * `DEMO_PROJECT_REFRESH_CRON_SECRET` (a shared bearer token), NOT a user
 * session, so the EventBridge scheduler can invoke it. Asserts the auth
 * boundary and the happy path through the real Elysia app + DB.
 *
 * Unlike `purge-abandoned-logs.endpoint.test.ts`'s reference case, the happy
 * path here actually runs `refreshDemoProject` — a full demo-project
 * reset+reseed — so it is given a longer per-test timeout, matching the
 * convention `refresh-demo-project.test.ts` (Phase 1) uses for the same
 * use case.
 */
describe("demo-project-refresh endpoint", () => {
  const SECRET = "test-demo-project-refresh-secret-abcdef0123456789";
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2031-06-15T12:00:00.000Z")),
    }),
  );

  const post = (headers?: HeadersInit) =>
    app.handle(
      new Request("http://localhost/api/internal/demo-project/refresh", {
        method: "POST",
        headers,
      }),
    );

  let original: string | undefined;
  beforeEach(() => {
    original = process.env["DEMO_PROJECT_REFRESH_CRON_SECRET"];
    process.env["DEMO_PROJECT_REFRESH_CRON_SECRET"] = SECRET;
  });
  afterEach(() => {
    if (original === undefined) {
      delete process.env["DEMO_PROJECT_REFRESH_CRON_SECRET"];
    } else {
      process.env["DEMO_PROJECT_REFRESH_CRON_SECRET"] = original;
    }
  });

  test("returns 401 without a service token", async () => {
    const res = await post();
    expect(res.status).toBe(401);
  });

  test("returns 401 with a wrong service token", async () => {
    const res = await post({ authorization: "Bearer wrong" });
    expect(res.status).toBe(401);
  });

  test("refreshes the demo project and returns its projectPath with the correct token", async () => {
    const res = await post({ authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projectPath: string };
    expect(typeof body.projectPath).toBe("string");
    expect(body.projectPath.length).toBeGreaterThan(0);
    expect(body.projectPath.startsWith("/")).toBe(true);
  }, 60_000);
});

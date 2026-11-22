import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fixedTimeProvider } from "tests/utils";

/**
 * Integration coverage for the scheduled maintenance endpoint
 * `POST /api/internal/executions/purge-abandoned-logs`. Guarded by
 * `createServiceAuthenticated` (a shared bearer token), NOT a user session, so
 * the EventBridge scheduler can invoke it. Asserts the auth boundary and the
 * happy path through the real Elysia app + DB (the use case is idempotent and a
 * fresh DB simply purges zero steps).
 *
 * The clock sits in the past so the sweep's cutoff precedes every lease in the
 * shared test database: a future clock would purge the live feeds of running
 * tasks that concurrently running test files are still asserting on.
 */
describe("purge-abandoned-logs endpoint", () => {
  const SECRET = "test-purge-secret-abcdef0123456789";
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2000-01-01T00:00:00.000Z")),
    }),
  );

  const post = (headers?: HeadersInit) =>
    app.handle(
      new Request(
        "http://localhost/api/internal/executions/purge-abandoned-logs",
        { method: "POST", headers },
      ),
    );

  let original: string | undefined;
  beforeEach(() => {
    original = process.env["RECONCILE_CRON_SECRET"];
    process.env["RECONCILE_CRON_SECRET"] = SECRET;
  });
  afterEach(() => {
    if (original === undefined) {
      delete process.env["RECONCILE_CRON_SECRET"];
    } else {
      process.env["RECONCILE_CRON_SECRET"] = original;
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

  test("purges and returns counts with the correct token", async () => {
    const res = await post({ authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stepsPurged: number;
      linesPurged: number;
    };
    expect(typeof body.stepsPurged).toBe("number");
    expect(typeof body.linesPurged).toBe("number");
    expect(body.stepsPurged).toBeGreaterThanOrEqual(0);
    expect(body.linesPurged).toBeGreaterThanOrEqual(0);
  });
});

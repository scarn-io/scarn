import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { posthogCaptureCalls } from "../test/posthog-node-mock";

// Assert against the shared posthog-node fake (installed via the bunfig
// preload, src/test/posthog-node-mock.ts) rather than mocking
// @scarn/observability/analytics/server. Mocking the whole analytics module here previously
// leaked across files in the same `bun test` run (mock.module is process-global
// and persistent), overriding captureApiEndpointTiming for
// posthog-api-timing.integration.test.ts. Driving the REAL analytics pipeline
// into the preload fake keeps both suites correct regardless of order.
const timingCalls = posthogCaptureCalls;

const importAnalytics = async () =>
  await import("@scarn/observability/analytics/server");
const importHelpers = async () => await import("./posthog-api-timing");

describe("posthog api timing", () => {
  beforeEach(async () => {
    timingCalls.length = 0;
    const analytics = await importAnalytics();
    analytics.init({ key: "phc_test", host: "https://t.example.test" });
  });

  afterEach(async () => {
    const analytics = await importAnalytics();
    await analytics.shutdown();
  });

  test("captures normalized route metadata for successful requests", async () => {
    const { applyPosthogApiTiming, buildRouteMetadata } = await importHelpers();
    const routeMetadataRef = { current: buildRouteMetadata([]) };
    const { app } = applyPosthogApiTiming(
      new Elysia({ prefix: "/api" }),
      routeMetadataRef,
    );
    const instrumentedApp = app
      .derive("plugin", () => ({ auth: { userId: "user-1" } }))
      .get(
        "/projects/:projectId",
        {
          detail: { operationId: "getProject", tags: ["Projects"] },
        },
        () => ({ ok: true }),
      );

    routeMetadataRef.current = buildRouteMetadata(instrumentedApp.routes);

    const response = await instrumentedApp.handle(
      new Request("http://localhost/api/projects/company-123"),
    );

    expect(response.status).toBe(200);
    expect(timingCalls).toHaveLength(1);
    expect(timingCalls[0]).toMatchObject({
      distinctId: "user-1",
      properties: {
        method: "GET",
        route: "/api/projects/:projectId",
        status_code: 200,
        ok: true,
        operation_id: "getProject",
        tags: ["Projects"],
      },
    });
    expect(timingCalls[0]?.properties?.["duration_ms"]).toEqual(
      expect.any(Number),
    );
    expect(timingCalls[0]?.properties?.["cpu_ms"]).toBeGreaterThanOrEqual(0);
  });

  test("attributes CPU-bound handler work to cpu_ms", async () => {
    const { applyPosthogApiTiming, buildRouteMetadata } = await importHelpers();
    const routeMetadataRef = { current: buildRouteMetadata([]) };
    const { app } = applyPosthogApiTiming(
      new Elysia({ prefix: "/api" }),
      routeMetadataRef,
    );
    const busyMs = 30;
    const instrumentedApp = app.get("/busy", () => {
      const start = process.cpuUsage();
      const cpuMsSince = () => {
        const { user, system } = process.cpuUsage(start);
        return (user + system) / 1000;
      };
      while (cpuMsSince() < busyMs) {
        // spin
      }
      return { ok: true };
    });
    routeMetadataRef.current = buildRouteMetadata(instrumentedApp.routes);

    await instrumentedApp.handle(new Request("http://localhost/api/busy"));

    expect(timingCalls).toHaveLength(1);
    expect(timingCalls[0]?.properties?.["cpu_ms"]).toBeGreaterThanOrEqual(
      busyMs * 0.5,
    );
  });

  test("does not count time spent awaiting I/O as cpu_ms", async () => {
    const { applyPosthogApiTiming, buildRouteMetadata } = await importHelpers();
    const routeMetadataRef = { current: buildRouteMetadata([]) };
    const { app } = applyPosthogApiTiming(
      new Elysia({ prefix: "/api" }),
      routeMetadataRef,
    );
    const waitMs = 100;
    const instrumentedApp = app.get("/waits", async () => {
      await Bun.sleep(waitMs);
      return { ok: true };
    });
    routeMetadataRef.current = buildRouteMetadata(instrumentedApp.routes);

    await instrumentedApp.handle(new Request("http://localhost/api/waits"));

    const properties = timingCalls[0]?.properties;
    expect(properties?.["duration_ms"]).toBeGreaterThanOrEqual(waitMs * 0.9);
    expect(properties?.["cpu_ms"]).toBeLessThan(waitMs / 2);
  });

  test("captures error responses and uses the authenticated user when available", async () => {
    const { applyPosthogApiTiming, buildRouteMetadata } = await importHelpers();
    const routeMetadataRef = { current: buildRouteMetadata([]) };
    const { app, captureErrorTiming } = applyPosthogApiTiming(
      new Elysia({ prefix: "/api" }),
      routeMetadataRef,
    );
    const instrumentedApp = app
      .onError((context) => {
        const problem = { status: 403, code: "FORBIDDEN" };
        context.set.status = problem.status;
        captureErrorTiming(context, problem);
        return problem;
      })
      .derive("plugin", () => ({ auth: { userId: "user-2" } }))
      .get(
        "/projects/:projectId/forbidden",
        {
          detail: {
            operationId: "forbiddenProject",
            tags: ["Projects"],
          },
        },
        () => {
          throw new Error("forbidden");
        },
      );

    routeMetadataRef.current = buildRouteMetadata(instrumentedApp.routes);

    const response = await instrumentedApp.handle(
      new Request("http://localhost/api/projects/company-999/forbidden"),
    );

    expect(response.status).toBe(403);
    expect(timingCalls).toHaveLength(1);
    expect(timingCalls[0]).toMatchObject({
      distinctId: "user-2",
      properties: {
        method: "GET",
        route: "/api/projects/:projectId/forbidden",
        status_code: 403,
        ok: false,
        operation_id: "forbiddenProject",
        tags: ["Projects"],
        error_code: "FORBIDDEN",
      },
    });
  });

  test("does not capture openapi routes", async () => {
    const { applyPosthogApiTiming, buildRouteMetadata } = await importHelpers();
    const routeMetadataRef = { current: buildRouteMetadata([]) };
    const { app } = applyPosthogApiTiming(
      new Elysia({ prefix: "/api" }),
      routeMetadataRef,
    );
    const instrumentedApp = app.get("/openapi", () => ({ ok: true }));

    routeMetadataRef.current = buildRouteMetadata(instrumentedApp.routes);

    const response = await instrumentedApp.handle(
      new Request("http://localhost/api/openapi"),
    );

    expect(response.status).toBe(200);
    expect(timingCalls).toEqual([]);
  });
});

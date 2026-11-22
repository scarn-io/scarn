import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import type {
  applyPosthogApiTiming as ApplyPosthogApiTimingFn,
  buildRouteMetadata as BuildRouteMetadataFn,
} from "./posthog-api-timing";
import { posthogCaptureCalls } from "../test/posthog-node-mock";

// posthog-node is mocked at the lowest boundary (the real cloud client) via the
// bunfig preload (src/test/posthog-node-mock.ts) rather than
// @scarn/observability/analytics/server. This exercises the REAL init() + capture pipeline
// in packages/observability/src/analytics/server.ts end-to-end, without any env vars and
// without sending anything over the network. The preload guarantees the fake is
// installed before analytics/server is evaluated, so this suite is correct
// regardless of test file execution order.
const captureCalls = posthogCaptureCalls;

const importModules = async () => {
  const analytics = await import("@scarn/observability/analytics/server");
  const timing = await import("./posthog-api-timing");
  return { analytics, timing };
};

// Reproduces the composition shape of createApp() in app.ts: the timing plugin
// wraps the base instance, onError is wired to capture error timings, and
// feature routes are mounted via .use() from a separate plugin instance that
// derives `auth` with scoped lifecycle (mirroring createAuthenticated).
const buildApp = (
  applyPosthogApiTiming: typeof ApplyPosthogApiTimingFn,
  buildRouteMetadata: typeof BuildRouteMetadataFn,
) => {
  const routeMetadataRef = { current: buildRouteMetadata([]) };
  const { app: timingApp, captureErrorTiming } = applyPosthogApiTiming(
    new Elysia({ prefix: "/api" }),
    routeMetadataRef,
  );

  const featureRoutes = new Elysia({ name: "feature" })
    .derive("plugin", () => ({ auth: { userId: "user-1" } }))
    .get(
      "/projects/:projectId",
      {
        detail: { operationId: "getProject", tags: ["Projects"] },
      },
      () => ({ ok: true }),
    )
    .get("/projects/:projectId/boom", () => {
      throw new Error("kaboom");
    });

  const app = timingApp
    .onError((context) => {
      const problem = { status: 500, code: "INTERNAL_SERVER_ERROR" };
      context.set.status = problem.status;
      captureErrorTiming(context, problem);
      return problem;
    })
    .use(featureRoutes);

  routeMetadataRef.current = buildRouteMetadata(app.routes);
  return app;
};

describe("posthog api timing (integration, real init pipeline)", () => {
  beforeEach(() => {
    captureCalls.length = 0;
  });

  afterEach(async () => {
    const { analytics } = await importModules();
    await analytics.shutdown();
  });

  test("emits api_endpoint_timed to the PostHog client once initialized", async () => {
    const { analytics, timing } = await importModules();
    analytics.init({ key: "phc_test", host: "https://t.example.test" });

    const app = buildApp(
      timing.applyPosthogApiTiming,
      timing.buildRouteMetadata,
    );

    const res = await app.handle(
      new Request("http://localhost/api/projects/p1"),
    );

    expect(res.status).toBe(200);
    expect(captureCalls).toHaveLength(1);
    expect(captureCalls[0]).toMatchObject({
      distinctId: "user-1",
      event: "api_endpoint_timed",
      properties: {
        method: "GET",
        route: "/api/projects/:projectId",
        status_code: 200,
        ok: true,
        operation_id: "getProject",
        tags: ["Projects"],
      },
    });
    expect(captureCalls[0]?.properties?.["duration_ms"]).toEqual(
      expect.any(Number),
    );
  });

  test("emits timing for error responses via the onError path", async () => {
    const { analytics, timing } = await importModules();
    analytics.init({ key: "phc_test", host: "https://t.example.test" });

    const app = buildApp(
      timing.applyPosthogApiTiming,
      timing.buildRouteMetadata,
    );

    const res = await app.handle(
      new Request("http://localhost/api/projects/p1/boom"),
    );

    expect(res.status).toBe(500);
    expect(captureCalls).toHaveLength(1);
    expect(captureCalls[0]).toMatchObject({
      event: "api_endpoint_timed",
      properties: {
        method: "GET",
        route: "/api/projects/:projectId/boom",
        status_code: 500,
        ok: false,
        error_code: "INTERNAL_SERVER_ERROR",
      },
    });
  });

  test("drops events silently when the client is never initialized", async () => {
    // This is the exact failure mode that masked the original bug: with no
    // init() the PostHog client is null and every capture is a no-op.
    const { timing } = await importModules();

    const app = buildApp(
      timing.applyPosthogApiTiming,
      timing.buildRouteMetadata,
    );

    const res = await app.handle(
      new Request("http://localhost/api/projects/p1"),
    );

    expect(res.status).toBe(200);
    expect(captureCalls).toEqual([]);
  });
});

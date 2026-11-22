import { Elysia } from "elysia";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAppContext, type AppContext } from "@scarn/core/lib/di";
import type { ProjectIntegrationRepo } from "@scarn/core/integrations/project-integration/application/project-integration-repo";
import { apiErrorHandler } from "../error-handler";
import { createIntegrationsPollRoutes } from "./integrations-poll";

const SECRET = "test-integration-poll-token-0123456789abcdef";
const OTHER_SECRET = "test-github-reconcile-token-abcdef0123456789";

// A fake repo with nothing due for auto-sync, so the route runs the real
// poller without a database. Every other method throws if called.
const notImplemented = (): never => {
  throw new Error("not implemented in this fake");
};

const fakeProjectIntegrationRepo: ProjectIntegrationRepo = {
  create: notImplemented,
  save: notImplemented,
  findById: notImplemented,
  listByProjectId: notImplemented,
  findByInstallationId: notImplemented,
  listActive: notImplemented,
  listDueForAutoSync: () => Promise.resolve([]),
  listBySyncSecretId: notImplemented,
  listBySyncSecretIds: notImplemented,
  claimForSync: notImplemented,
  releaseSyncClaim: notImplemented,
  delete: notImplemented,
  deleteByInstallationId: notImplemented,
};

const buildApp = (appContext: AppContext) =>
  new Elysia()
    .onError((context) => apiErrorHandler(context))
    .use(createIntegrationsPollRoutes(appContext));

const post = (app: ReturnType<typeof buildApp>, headers?: HeadersInit) =>
  app.handle(
    new Request("http://localhost/internal/integrations/poll", {
      method: "POST",
      headers,
    }),
  );

describe("POST /internal/integrations/poll", () => {
  const appContext = createAppContext({
    projectIntegrationRepo: fakeProjectIntegrationRepo,
  });

  let original: string | undefined;
  let originalOther: string | undefined;

  beforeEach(() => {
    original = process.env["INTEGRATION_POLL_CRON_SECRET"];
    process.env["INTEGRATION_POLL_CRON_SECRET"] = SECRET;
    originalOther = process.env["GITHUB_RECONCILE_CRON_SECRET"];
    process.env["GITHUB_RECONCILE_CRON_SECRET"] = OTHER_SECRET;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env["INTEGRATION_POLL_CRON_SECRET"];
    } else {
      process.env["INTEGRATION_POLL_CRON_SECRET"] = original;
    }
    if (originalOther === undefined) {
      delete process.env["GITHUB_RECONCILE_CRON_SECRET"];
    } else {
      process.env["GITHUB_RECONCILE_CRON_SECRET"] = originalOther;
    }
  });

  test("returns 401 without a bearer token", async () => {
    const res = await post(buildApp(appContext));
    expect(res.status).toBe(401);
  });

  test("returns 401 with a wrong bearer token", async () => {
    const res = await post(buildApp(appContext), {
      authorization: "Bearer wrong-token",
    });
    expect(res.status).toBe(401);
  });

  test("returns 401 with a token that only matches another cron secret", async () => {
    const res = await post(buildApp(appContext), {
      authorization: `Bearer ${OTHER_SECRET}`,
    });
    expect(res.status).toBe(401);
  });

  test("returns 200 with the poller's counts given a valid INTEGRATION_POLL_CRON_SECRET token", async () => {
    const res = await post(buildApp(appContext), {
      authorization: `Bearer ${SECRET}`,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      attempted: 0,
      succeeded: 0,
      failed: 0,
      paused: 0,
      skippedLocked: 0,
      skippedRateLimited: 0,
    });
  });
});

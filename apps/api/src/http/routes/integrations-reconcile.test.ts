import { Elysia } from "elysia";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAppContext, type AppContext } from "@scarn/core/lib/di";
import type { ProjectIntegrationRepo } from "@scarn/core/integrations/project-integration/application/project-integration-repo";
import { apiErrorHandler } from "../error-handler";
import { createIntegrationsReconcileRoutes } from "./integrations-reconcile";

const SECRET = "test-github-reconcile-token-0123456789abcdef";
const OLD_SECRET = "test-old-reconcile-token-abcdef0123456789";

// A fake repo that always reports no active integrations, so the route
// exercises `reconcileActiveIntegrations`'s real logic (zero attempted, zero
// succeeded, zero failed) without touching a real database. Every other
// method throws if called — nothing in this test's happy path should reach
// them.
const notImplemented = (): never => {
  throw new Error("not implemented in this fake");
};

const fakeProjectIntegrationRepo: ProjectIntegrationRepo = {
  create: notImplemented,
  save: notImplemented,
  findById: notImplemented,
  listByProjectId: notImplemented,
  findByInstallationId: notImplemented,
  listActive: () => Promise.resolve([]),
  listDueForAutoSync: notImplemented,
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
    .use(createIntegrationsReconcileRoutes(appContext));

const post = (app: ReturnType<typeof buildApp>, headers?: HeadersInit) =>
  app.handle(
    new Request("http://localhost/internal/integrations/reconcile", {
      method: "POST",
      headers,
    }),
  );

describe("POST /internal/integrations/reconcile", () => {
  const appContext = createAppContext({
    projectIntegrationRepo: fakeProjectIntegrationRepo,
  });

  let original: string | undefined;
  let originalOld: string | undefined;

  beforeEach(() => {
    original = process.env["GITHUB_RECONCILE_CRON_SECRET"];
    process.env["GITHUB_RECONCILE_CRON_SECRET"] = SECRET;
    originalOld = process.env["RECONCILE_CRON_SECRET"];
    process.env["RECONCILE_CRON_SECRET"] = OLD_SECRET;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env["GITHUB_RECONCILE_CRON_SECRET"];
    } else {
      process.env["GITHUB_RECONCILE_CRON_SECRET"] = original;
    }
    if (originalOld === undefined) {
      delete process.env["RECONCILE_CRON_SECRET"];
    } else {
      process.env["RECONCILE_CRON_SECRET"] = originalOld;
    }
  });

  test("returns 401 without a bearer token", async () => {
    const res = await post(buildApp(appContext));
    expect(res.status).toBe(401);
  });

  test("returns 401 with a token that only matches the old RECONCILE_CRON_SECRET", async () => {
    const res = await post(buildApp(appContext), {
      authorization: `Bearer ${OLD_SECRET}`,
    });
    expect(res.status).toBe(401);
  });

  test("returns 200 with the reconciliation counts given a valid GITHUB_RECONCILE_CRON_SECRET token", async () => {
    const res = await post(buildApp(appContext), {
      authorization: `Bearer ${SECRET}`,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      integrationsAttempted: number;
      integrationsSucceeded: number;
      integrationsFailed: number;
    };
    expect(body).toEqual({
      integrationsAttempted: 0,
      integrationsSucceeded: 0,
      integrationsFailed: 0,
    });
  });
});

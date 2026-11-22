import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAppContext } from "@scarn/core/lib/di";
import {
  createUuidV7,
  parseUuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { WorkItemEntity } from "@scarn/core/work-items/work-item/domain/work-item-entity";
import {
  WEBHOOK_SECRET,
  anIssue,
  buildApp,
  makeGitHubIntegration,
  makeProjectIntegrationRepo,
  makeProjectRepo,
  makeWorkItemRepo,
  noWorkItemEvents,
  postWebhook,
} from "./github-integration-test-support";
import { REQUIRED_AUTH_ENV, restoreEnv } from "../../test/fake-session";

describe("POST /integrations/github/webhook — issues.* dispatch", () => {
  let originalSecret: string | undefined;
  let originalDatabaseUrl: string | undefined;

  beforeEach(() => {
    originalSecret = process.env["GITHUB_APP_WEBHOOK_SECRET"];
    originalDatabaseUrl = process.env["DATABASE_URL"];
    process.env["GITHUB_APP_WEBHOOK_SECRET"] = WEBHOOK_SECRET;
    // The upsert opens its event transaction through `getDb()`, which only
    // needs the URL set; the faked repos and events never query it.
    process.env["DATABASE_URL"] = REQUIRED_AUTH_ENV.DATABASE_URL;
  });

  afterEach(() => {
    restoreEnv("GITHUB_APP_WEBHOOK_SECRET", originalSecret);
    restoreEnv("DATABASE_URL", originalDatabaseUrl);
  });

  test("a valid-signature issues.opened payload creates a work item", async () => {
    const projectId = createUuidV7().toString();
    const integration = makeGitHubIntegration({
      projectId,
      installationId: "12345",
      repoId: 999,
      repoFullName: "acme/repo",
    });
    const { repo: workItemRepo, saveCalls } = makeWorkItemRepo();
    const appContext = createAppContext({
      projectRepo: makeProjectRepo([projectId]),
      projectIntegrationRepo: makeProjectIntegrationRepo([integration]),
      workItemRepo,
      workItemEvents: noWorkItemEvents,
    });

    const res = await postWebhook(buildApp(appContext), "issues", {
      action: "opened",
      installation: { id: 12345 },
      repository: { id: 999, full_name: "acme/repo" },
      issue: anIssue(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; applied: boolean };
    expect(body).toEqual({ ok: true, applied: true });

    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0]?.[0]?.projectId).toBe(parseUuidV7(projectId));
    expect(saveCalls[0]?.[0]?.platformKey).toBe("acme/repo#42");
    expect(saveCalls[0]?.[0]?.title).toBe("Something broke");
  });

  test("issues.edited updates title/state on the mapped work item", async () => {
    const projectId = createUuidV7().toString();
    const integration = makeGitHubIntegration({
      projectId,
      installationId: "12345",
      repoId: 999,
      repoFullName: "acme/repo",
    });
    const existing = WorkItemEntity.create({
      projectId: parseUuidV7(projectId),
      platform: "github",
      platformKey: "acme/repo#42",
      title: "Old title",
      fields: { state: "open" },
    });
    const { repo: workItemRepo, saveCalls } = makeWorkItemRepo({ existing });
    const appContext = createAppContext({
      projectRepo: makeProjectRepo([projectId]),
      projectIntegrationRepo: makeProjectIntegrationRepo([integration]),
      workItemRepo,
      workItemEvents: noWorkItemEvents,
    });

    const res = await postWebhook(buildApp(appContext), "issues", {
      action: "edited",
      installation: { id: 12345 },
      repository: { id: 999, full_name: "acme/repo" },
      issue: anIssue({
        title: "Fixed title",
        state: "closed",
        updated_at: "2026-07-02T00:00:00Z",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, applied: true });

    expect(saveCalls).toHaveLength(1);
    const upserted = saveCalls[0]?.[0];
    expect(upserted?.title).toBe("Fixed title");
    expect(upserted?.fields["state"]).toBe("closed");
  });

  test("issues.closed sets state to closed and a later issues.reopened sets it back to open", async () => {
    const projectId = createUuidV7().toString();
    const integration = makeGitHubIntegration({
      projectId,
      installationId: "12345",
      repoId: 999,
      repoFullName: "acme/repo",
    });
    const applied: WorkItemEntity[] = [];
    const { repo: workItemRepo } = makeWorkItemRepo({
      saveResult: (entities) =>
        entities.filter((entity) => {
          const storedAt = applied.at(-1)?.sourceUpdatedAt?.getTime() ?? 0;
          if ((entity.sourceUpdatedAt?.getTime() ?? 0) <= storedAt) {
            return false;
          }
          applied.push(entity);
          return true;
        }),
    });
    const appContext = createAppContext({
      projectRepo: makeProjectRepo([projectId]),
      projectIntegrationRepo: makeProjectIntegrationRepo([integration]),
      workItemRepo,
      workItemEvents: noWorkItemEvents,
    });
    const app = buildApp(appContext);

    const closedRes = await postWebhook(app, "issues", {
      action: "closed",
      installation: { id: 12345 },
      repository: { id: 999, full_name: "acme/repo" },
      issue: anIssue({
        state: "closed",
        state_reason: "completed",
        updated_at: "2026-07-02T00:00:00Z",
        closed_at: "2026-07-02T00:00:00Z",
      }),
    });

    expect(closedRes.status).toBe(200);
    expect(await closedRes.json()).toEqual({ ok: true, applied: true });
    expect(applied.at(-1)?.state).toBe("closed");

    const reopenedRes = await postWebhook(app, "issues", {
      action: "reopened",
      installation: { id: 12345 },
      repository: { id: 999, full_name: "acme/repo" },
      issue: anIssue({
        state: "open",
        state_reason: "reopened",
        updated_at: "2026-07-03T00:00:00Z",
      }),
    });

    expect(reopenedRes.status).toBe(200);
    expect(await reopenedRes.json()).toEqual({ ok: true, applied: true });
    expect(applied).toHaveLength(2);
    expect(applied.at(-1)?.state).toBe("open");
  });

  test("a stale/out-of-order delivery the repo rejects is reported as a no-op, not an error", async () => {
    const projectId = createUuidV7().toString();
    const integration = makeGitHubIntegration({
      projectId,
      installationId: "12345",
      repoId: 999,
      repoFullName: "acme/repo",
    });
    // Simulates `saveManyIfSourceNewer`'s atomic guard rejecting the row —
    // the DB-level behavior itself is covered by
    // packages/core/tests/work-items/work-item/integration/work-item.save-many-if-source-newer.test.ts.
    const { repo: workItemRepo } = makeWorkItemRepo({ saveResult: () => [] });
    const appContext = createAppContext({
      projectRepo: makeProjectRepo([projectId]),
      projectIntegrationRepo: makeProjectIntegrationRepo([integration]),
      workItemRepo,
      workItemEvents: noWorkItemEvents,
    });

    const res = await postWebhook(buildApp(appContext), "issues", {
      action: "edited",
      installation: { id: 12345 },
      repository: { id: 999, full_name: "acme/repo" },
      issue: anIssue({ updated_at: "2025-01-01T00:00:00Z" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, applied: false });
  });

  test("an unhandled event/action still falls through to { ok: true, ignored }", async () => {
    const appContext = createAppContext({
      projectRepo: makeProjectRepo([]),
      projectIntegrationRepo: makeProjectIntegrationRepo([]),
      workItemRepo: makeWorkItemRepo().repo,
      workItemEvents: noWorkItemEvents,
    });

    const res = await postWebhook(buildApp(appContext), "issues", {
      action: "milestoned",
      installation: { id: 12345 },
      repository: { id: 999, full_name: "acme/repo" },
      issue: anIssue(),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: "issues" });

    const pushRes = await postWebhook(buildApp(appContext), "push", {});
    expect(pushRes.status).toBe(200);
    expect(await pushRes.json()).toEqual({ ok: true, ignored: "push" });
  });

  test("routes to the matching project only, never a sibling project sharing the same installation", async () => {
    const projectAId = createUuidV7().toString();
    const projectBId = createUuidV7().toString();
    const integrationA = makeGitHubIntegration({
      projectId: projectAId,
      installationId: "55555",
      repoId: 1,
      repoFullName: "acme/repo-a",
    });
    const integrationB = makeGitHubIntegration({
      projectId: projectBId,
      installationId: "55555",
      repoId: 2,
      repoFullName: "acme/repo-b",
    });
    const { repo: workItemRepo, saveCalls } = makeWorkItemRepo();
    const appContext = createAppContext({
      projectRepo: makeProjectRepo([projectAId, projectBId]),
      projectIntegrationRepo: makeProjectIntegrationRepo([
        integrationA,
        integrationB,
      ]),
      workItemRepo,
      workItemEvents: noWorkItemEvents,
    });

    const res = await postWebhook(buildApp(appContext), "issues", {
      action: "opened",
      installation: { id: 55555 },
      repository: { id: 1, full_name: "acme/repo-a" },
      issue: anIssue(),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, applied: true });
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0]?.[0]?.projectId).toBe(parseUuidV7(projectAId));
    expect(saveCalls[0]?.[0]?.projectId).not.toBe(parseUuidV7(projectBId));
    expect(saveCalls[0]?.[0]?.platformKey).toBe("acme/repo-a#42");
  });

  test("a repo id matching no integration's scope is ignored, touching no work item", async () => {
    const projectId = createUuidV7().toString();
    const integration = makeGitHubIntegration({
      projectId,
      installationId: "12345",
      repoId: 999,
      repoFullName: "acme/repo",
    });
    const { repo: workItemRepo, saveCalls } = makeWorkItemRepo();
    const appContext = createAppContext({
      projectRepo: makeProjectRepo([projectId]),
      projectIntegrationRepo: makeProjectIntegrationRepo([integration]),
      workItemRepo,
      workItemEvents: noWorkItemEvents,
    });

    const res = await postWebhook(buildApp(appContext), "issues", {
      action: "opened",
      installation: { id: 12345 },
      repository: { id: 1234567, full_name: "acme/unrelated-repo" },
      issue: anIssue(),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      ignored: "no_matching_project_integration",
    });
    expect(saveCalls).toHaveLength(0);
  });

  test("rejects a payload with an invalid webhook signature", async () => {
    const appContext = createAppContext({
      projectRepo: makeProjectRepo([]),
      projectIntegrationRepo: makeProjectIntegrationRepo([]),
      workItemRepo: makeWorkItemRepo().repo,
      workItemEvents: noWorkItemEvents,
    });
    const rawBody = JSON.stringify({
      action: "opened",
      installation: { id: 1 },
      repository: { id: 1, full_name: "acme/repo" },
      issue: anIssue(),
    });

    const res = await buildApp(appContext).handle(
      new Request("http://localhost/integrations/github/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-hub-signature-256": "sha256=deadbeef",
        },
        body: rawBody,
      }),
    );

    expect(res.status).toBe(401);
  });
});

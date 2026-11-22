import { Elysia } from "elysia";
import { createHmac } from "node:crypto";
import type { AppContext } from "@scarn/core/lib/di";
import {
  createUuidV7,
  parseUuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { ProjectEntity } from "@scarn/core/projects/project/domain/project-entity";
import type { ProjectRepo } from "@scarn/core/projects/project/application/project-repo";
import { GitHubAppProjectIntegration } from "@scarn/core/integrations/project-integration/domain/project-integration-entity";
import type { ProjectIntegrationRepo } from "@scarn/core/integrations/project-integration/application/project-integration-repo";
import type { WorkItemRepo } from "@scarn/core/work-items/work-item/application/work-item-repo";
import type { WorkItemEntity } from "@scarn/core/work-items/work-item/domain/work-item-entity";
import type { WorkItemEventsPort } from "@scarn/core/work-items/work-item/application/work-item-events-port";
import type { GitHubIssue } from "@scarn/core/integrations/github-ingest/infra/github-issues-client";
import { apiErrorHandler } from "../error-handler";
import { createGitHubIntegrationRoutes } from "./github-integration";

/**
 * In-memory fakes and signed-delivery helpers for
 * `github-integration.test.ts`.
 */
export const WEBHOOK_SECRET = "test-github-webhook-secret";

const sign = (body: string): string =>
  `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;

const notImplemented = (): never => {
  throw new Error("not implemented in this fake");
};

const orgId = createUuidV7();
const creatorId = createUuidV7();

export const makeProjectRepo = (projectIds: string[]): ProjectRepo => {
  const projects = new Map(
    projectIds.map((id) => [
      id,
      ProjectEntity.create({
        id: parseUuidV7(id),
        name: `Project ${id}`,
        slug: `project-${id}`,
        gitUrl: "https://github.com/acme/repo.git",
        createdByUserId: creatorId,
        orgId,
        memberships: [],
      }),
    ]),
  );

  return {
    load: (id) => Promise.resolve(projects.get(id) ?? null),
    loadForUpdate: (id) => Promise.resolve(projects.get(id) ?? null),
    loadMany: notImplemented,
    listByUser: notImplemented,
    loadByOrgAndSlug: notImplemented,
    listSlugsByOrg: notImplemented,
    create: notImplemented,
    save: notImplemented,
  };
};

export const makeProjectIntegrationRepo = (
  integrations: GitHubAppProjectIntegration[],
): ProjectIntegrationRepo => ({
  create: notImplemented,
  save: notImplemented,
  findById: notImplemented,
  listByProjectId: notImplemented,
  findByInstallationId: (installationId) =>
    Promise.resolve(
      integrations.filter((i) => i.installationId === installationId),
    ),
  listActive: notImplemented,
  listDueForAutoSync: notImplemented,
  listBySyncSecretId: notImplemented,
  listBySyncSecretIds: notImplemented,
  claimForSync: notImplemented,
  releaseSyncClaim: notImplemented,
  delete: notImplemented,
  deleteByInstallationId: notImplemented,
});

export const makeGitHubIntegration = (opts: {
  projectId: string;
  installationId: string;
  repoId: number;
  repoFullName: string;
}): GitHubAppProjectIntegration =>
  GitHubAppProjectIntegration.rehydrate({
    id: createUuidV7(),
    projectId: parseUuidV7(opts.projectId),
    installationId: opts.installationId,
    scope: {
      repos: [{ id: opts.repoId, fullName: opts.repoFullName }],
    },
    status: "active",
    lastSyncedAt: null,
    lastError: null,
    firstSyncHorizonDays: null,
    syncSecretId: null,
    autoSyncPausedReason: null,
    autoSyncPausedAt: null,
    autoSyncPausedDetail: null,
  });

export const makeWorkItemRepo = (
  opts: {
    existing?: WorkItemEntity | null;
    saveResult?: (entities: WorkItemEntity[]) => WorkItemEntity[];
  } = {},
): {
  repo: WorkItemRepo;
  saveCalls: WorkItemEntity[][];
} => {
  const saveCalls: WorkItemEntity[][] = [];
  const repo: WorkItemRepo = {
    load: notImplemented,
    // The automation runner reloads the upserted work items; empty means no
    // project automation sees them, which none of these routes exercise.
    loadMany: () => Promise.resolve([]),
    listChildren: notImplemented,
    countSpawnedByTask: notImplemented,
    listPageByProjectId: notImplemented,
    listFieldOptions: notImplemented,
    listLabels: notImplemented,
    loadByPlatformIdentity: notImplemented,
    loadManyByPlatformIdentities: () =>
      Promise.resolve(opts.existing ? [opts.existing] : []),
    create: notImplemented,
    createMany: notImplemented,
    save: notImplemented,
    saveDescription: notImplemented,
    saveMany: notImplemented,
    saveManyIfSourceNewer: (entities) => {
      saveCalls.push(entities);
      return Promise.resolve(
        opts.saveResult ? opts.saveResult(entities) : entities,
      );
    },
    setStateMany: (entities) => Promise.resolve(entities),
    delete: notImplemented,
    deleteMany: notImplemented,
    deleteByProjectId: notImplemented,
  };
  return { repo, saveCalls };
};

/**
 * Stands in for the DB-backed `AutomationRunner`, which these routes never
 * exercise, so the upsert's work item events stay in memory.
 */
export const noWorkItemEvents = (): WorkItemEventsPort => ({
  created: () => Promise.resolve(),
  mayHaveBecomeReady: () => Promise.resolve(),
  closed: () => Promise.resolve(),
  labelsAdded: () => Promise.resolve(),
});

export const buildApp = (appContext: AppContext) =>
  new Elysia()
    .onError((context) => apiErrorHandler(context))
    .use(createGitHubIntegrationRoutes(appContext));

type GitHubWebhookTestPayload = {
  action?: string;
  installation?: { id?: number };
  repository?: { id?: number; full_name?: string };
  issue?: GitHubIssue;
};

export const postWebhook = (
  app: ReturnType<typeof buildApp>,
  event: string,
  body: GitHubWebhookTestPayload,
) => {
  const rawBody = JSON.stringify(body);
  return app.handle(
    new Request("http://localhost/integrations/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-hub-signature-256": sign(rawBody),
      },
      body: rawBody,
    }),
  );
};

export const anIssue = (overrides: Partial<GitHubIssue> = {}): GitHubIssue => ({
  id: 1,
  node_id: "I_1",
  number: 42,
  title: "Something broke",
  body: "Steps to reproduce",
  html_url: "https://github.com/acme/repo/issues/42",
  state: "open",
  state_reason: null,
  user: { login: "alice" },
  labels: [],
  assignees: [],
  comments: 0,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z",
  closed_at: null,
  ...overrides,
});

import { generateKeyPairSync } from "node:crypto";
import {
  GitHubAppProjectIntegration,
  GitHubTokenProjectIntegration,
  JiraProjectIntegration,
  isGitHubAppIntegration,
  type ProjectIntegrationEntity,
} from "@/integrations/project-integration/domain/project-integration-entity";
import type { ProjectIntegrationRepo } from "@/integrations/project-integration/application/project-integration-repo";
import type { ProjectRepo } from "@/projects/project/application/project-repo";
import { ProjectEntity } from "@/projects/project/domain/project-entity";
import type { WorkItemRepo } from "@/work-items/work-item/application/work-item-repo";
import type { WorkItemEntity } from "@/work-items/work-item/domain/work-item-entity";
import type { WorkItemBlockRepo } from "@/work-items/work-item-block/application/work-item-block-repo";
import type { WorkItemEventsPort } from "@/work-items/work-item/application/work-item-events-port";
import type { SecretRepo } from "@/secrets/secret/application/secret-repo";
import type { SecretCipher } from "@/secrets/secret/application/secret-cipher";
import {
  parseUuidV7,
  createUuidV7,
  type UuidV7,
} from "@/common/contracts/uuid-v7";
import { fixedTimeProvider } from "tests/utils";
import { makeGithubRelationshipPendingRefRepo } from "./ingest-github-issue-relationships-test-support";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

export const projectId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f02");
const orgId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f03");
const creatorId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f04");

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const jsonResponse = (
  body: JsonValue,
  init: { status?: number } = {},
): Response =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });

export const toRequestUrl = (input: string | URL | Request): string =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;

export const makeIssue = (id: number, updatedAt: string): JsonValue => ({
  id,
  node_id: `I_${String(id)}`,
  number: id,
  title: `Issue ${String(id)}`,
  body: "Repro",
  html_url: `https://github.com/acme/repo/issues/${String(id)}`,
  state: "open",
  state_reason: null,
  user: { login: "alice" },
  labels: [],
  assignees: [],
  comments: 0,
  created_at: updatedAt,
  updated_at: updatedAt,
  closed_at: null,
});

/**
 * Serves a canned installation token (401 for `failingInstallationId`) + a
 * per-repo canned issue list, recording every URL requested.
 */
export const makeFetchImpl = (opts: {
  failingInstallationId?: string;
  issuesByRepo: Record<string, JsonValue[]>;
}): { fetchImpl: typeof fetch; calls: string[] } => {
  const calls: string[] = [];
  const fetchImpl = ((input: string | URL | Request) => {
    const url = toRequestUrl(input);
    calls.push(url);
    if (
      opts.failingInstallationId &&
      url.includes(`/installations/${opts.failingInstallationId}/access_tokens`)
    ) {
      return Promise.resolve(
        jsonResponse({ message: "Bad credentials" }, { status: 401 }),
      );
    }
    if (url.includes("/access_tokens")) {
      return Promise.resolve(
        jsonResponse({
          token: "installation-token",
          expires_at: "2026-05-24T13:00:00Z",
        }),
      );
    }
    if (url.includes("/graphql")) {
      // No issue in these fixtures has parent/blockedBy relationships worth
      // resolving; an empty `data` payload is enough for
      // `fetchIssueRelationshipsBatch` to report no relationships for any
      // issue.
      return Promise.resolve(jsonResponse({ data: {} }));
    }
    const repoFullName = /\/repos\/([^/]+\/[^/]+)\/issues/.exec(url)?.[1] ?? "";
    return Promise.resolve(jsonResponse(opts.issuesByRepo[repoFullName] ?? []));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
};

export const makeGitHubIntegration = (
  installationId: string,
  repoFullName: string,
  status: "active" | "error" | "paused" = "active",
): ProjectIntegrationEntity =>
  GitHubAppProjectIntegration.rehydrate({
    id: createUuidV7(),
    projectId,
    installationId,
    scope: { repos: [{ id: 1, fullName: repoFullName }] },
    status,
    lastSyncedAt: null,
    lastError: null,
    firstSyncHorizonDays: null,
    syncSecretId: null,
    autoSyncPausedReason: null,
    autoSyncPausedAt: null,
    autoSyncPausedDetail: null,
  });

export const makeGitHubTokenIntegration = (
  repoFullName: string,
): ProjectIntegrationEntity =>
  GitHubTokenProjectIntegration.rehydrate({
    id: createUuidV7(),
    projectId,
    scope: { repos: [{ id: 2, fullName: repoFullName }] },
    status: "active",
    lastSyncedAt: null,
    lastError: null,
    firstSyncHorizonDays: null,
    syncSecretId: null,
    autoSyncPausedReason: null,
    autoSyncPausedAt: null,
    autoSyncPausedDetail: null,
  });

export const makeJiraIntegration = (): ProjectIntegrationEntity =>
  JiraProjectIntegration.rehydrate({
    id: createUuidV7(),
    projectId,
    scope: {
      baseUrl: "https://acme.atlassian.net",
      projectKeys: ["ACME"],
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

/**
 * Mirrors the real `DrizzleProjectIntegrationRepo.listActive()` filtering
 * (`status IN ('active', 'error')`, excludes `paused`) so the orchestrator's
 * consumption of whatever `listActive()` returns is what's under test.
 */
export const makeProjectIntegrationRepo = (
  integrations: ProjectIntegrationEntity[],
): { repo: ProjectIntegrationRepo; findByIdOrder: UuidV7[] } => {
  const stored = new Map(integrations.map((entry) => [entry.id, entry]));
  const findByIdOrder: UuidV7[] = [];

  const repo: ProjectIntegrationRepo = {
    create(entity) {
      stored.set(entity.id, entity);
      return Promise.resolve(entity);
    },
    save(entity) {
      stored.set(entity.id, entity);
      return Promise.resolve(entity);
    },
    findById(id) {
      findByIdOrder.push(id);
      return Promise.resolve(stored.get(id) ?? null);
    },
    listByProjectId() {
      return Promise.resolve([...stored.values()]);
    },
    findByInstallationId() {
      return Promise.resolve(
        [...stored.values()].filter(isGitHubAppIntegration),
      );
    },
    listActive() {
      return Promise.resolve(
        [...stored.values()].filter(
          (entry) => entry.status === "active" || entry.status === "error",
        ),
      );
    },
    listDueForAutoSync() {
      return Promise.resolve([]);
    },
    listBySyncSecretId() {
      return Promise.resolve([]);
    },
    listBySyncSecretIds() {
      return Promise.resolve([]);
    },
    claimForSync() {
      return Promise.resolve(true);
    },
    releaseSyncClaim() {
      return Promise.resolve();
    },
    delete() {
      return Promise.resolve(0);
    },
    deleteByInstallationId() {
      return Promise.resolve(0);
    },
  };

  return { repo, findByIdOrder };
};

const makeProjectRepo = (): ProjectRepo => {
  const project = ProjectEntity.create({
    id: projectId,
    name: "Test project",
    slug: "test-project",
    gitUrl: "https://github.com/acme/test-project.git",
    createdByUserId: creatorId,
    orgId,
    memberships: [],
  });

  return {
    load: (id) => Promise.resolve(id === projectId ? project : null),
    loadForUpdate: (id) => Promise.resolve(id === projectId ? project : null),
    loadMany: () => Promise.resolve([]),
    listByUser: () => Promise.resolve([]),
    loadByOrgAndSlug: () => Promise.resolve(null),
    listSlugsByOrg: () => Promise.resolve([]),
    create: (entity) => Promise.resolve(entity),
    save: (entity) => Promise.resolve(entity),
  };
};

const makeWorkItemRepo = (): {
  repo: WorkItemRepo;
  savedBatches: WorkItemEntity[][];
} => {
  const savedBatches: WorkItemEntity[][] = [];
  const repo: WorkItemRepo = {
    load: () => Promise.resolve(null),
    loadMany: () => Promise.resolve([]),
    listChildren: () => Promise.resolve([]),
    countSpawnedByTask: () => Promise.resolve(0),
    listPageByProjectId: () => Promise.resolve({ items: [], total: 0 }),
    listFieldOptions: () => Promise.resolve([]),
    listLabels: () => Promise.resolve([]),
    loadByPlatformIdentity: () => Promise.resolve(null),
    loadManyByPlatformIdentities: () => Promise.resolve([]),
    create: (workItem) => Promise.resolve(workItem),
    createMany: (workItems) => Promise.resolve(workItems),
    save: (workItem) => Promise.resolve(workItem),
    saveDescription: (workItem) => Promise.resolve(workItem),
    saveMany: (workItems) => {
      savedBatches.push(workItems);
      return Promise.resolve(workItems);
    },
    saveManyIfSourceNewer: (workItems) => {
      savedBatches.push(workItems);
      return Promise.resolve(workItems);
    },
    setStateMany: (workItems) => Promise.resolve(workItems),
    delete: () => Promise.resolve(0),
    deleteMany: () => Promise.resolve(0),
    deleteByProjectId: () => Promise.resolve(0),
  };
  return { repo, savedBatches };
};

/** A dependency that must never be invoked in these tests (guarded by a throw). */
const makeUnusedRepo = (name: string): object =>
  new Proxy(
    {},
    {
      get() {
        throw new Error(`Unexpected call to unused dependency: ${name}`);
      },
    },
  );

export const baseDeps = () => {
  const { repo: projectRepo } = { repo: makeProjectRepo() };
  const { repo: workItemRepo, savedBatches } = makeWorkItemRepo();
  return {
    projectRepo,
    workItemRepo,
    workItemBlockRepo: makeUnusedRepo("workItemBlockRepo") as WorkItemBlockRepo,
    workItemEvents: {
      created: () => Promise.resolve(),
      mayHaveBecomeReady: () => Promise.resolve(),
      closed: () => Promise.resolve(),
      labelsAdded: () => Promise.resolve(),
    } satisfies WorkItemEventsPort,
    githubRelationshipPendingRefRepo:
      makeGithubRelationshipPendingRefRepo().repo,
    savedBatches,
    secretRepo: makeUnusedRepo("secretRepo") as SecretRepo,
    secretCipher: makeUnusedRepo("secretCipher") as SecretCipher,
    timeProvider: fixedTimeProvider(new Date("2026-06-15T12:00:00.000Z")),
    githubApp: { appId: "12345", privateKey },
  };
};

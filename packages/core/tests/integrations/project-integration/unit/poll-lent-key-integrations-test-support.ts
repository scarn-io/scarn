import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import type { PollLentKeyIntegrationsDeps } from "@/integrations/project-integration/application/poll-lent-key-integrations";
import type { ProjectIntegrationRepo } from "@/integrations/project-integration/application/project-integration-repo";
import {
  GitHubTokenProjectIntegration,
  JiraProjectIntegration,
  type ProjectIntegrationEntity,
} from "@/integrations/project-integration/domain/project-integration-entity";
import { ProjectEntity } from "@/projects/project/domain/project-entity";
import type { ProjectRepo } from "@/projects/project/application/project-repo";
import type { SecretEntity } from "@/secrets/secret/domain/secret-entity";
import {
  baseDeps,
  jsonResponse,
  toRequestUrl,
} from "../../github-ingest/unit/reconcile-active-integrations-test-support";
import { createResolverHarness } from "../../../secrets/secret/unit/credential-resolver-test-support";
import {
  fakeAutoSyncPausedNotifications,
  fakeDbExecutor,
} from "../../../notifications/user-notification/unit/auto-sync-paused-notifications-fake";

export { jsonResponse, toRequestUrl };

export const POLL_NOW = new Date("2026-10-20T12:00:00.000Z");

const baseProps = (projectId: UuidV7, syncSecretId: UuidV7) => ({
  id: createUuidV7(),
  projectId,
  status: "active" as const,
  lastSyncedAt: null,
  lastError: null,
  firstSyncHorizonDays: null,
  syncSecretId,
  autoSyncPausedReason: null,
  autoSyncPausedAt: null,
  autoSyncPausedDetail: null,
});

/**
 * In-memory `ProjectIntegrationRepo` for the poller: `listDueForAutoSync`
 * mirrors the real filter, `held` IDs fail `claimForSync`, and every claim
 * and release is logged.
 */
const makeRepo = (stored: Map<UuidV7, ProjectIntegrationEntity>) => {
  const held = new Set<UuidV7>();
  const claims: Array<{ id: UuidV7; until: Date }> = [];
  const released: UuidV7[] = [];
  const repo: ProjectIntegrationRepo = {
    create: (entity) => {
      stored.set(entity.id, entity);
      return Promise.resolve(entity);
    },
    save: (entity) => {
      stored.set(entity.id, entity);
      return Promise.resolve(entity);
    },
    findById: (id) => Promise.resolve(stored.get(id) ?? null),
    listByProjectId: () => Promise.resolve([...stored.values()]),
    findByInstallationId: () => Promise.resolve([]),
    listActive: () => Promise.resolve([]),
    listDueForAutoSync: () =>
      Promise.resolve(
        [...stored.values()].filter(
          (entry) =>
            entry.syncSecretId !== null &&
            (entry.status === "active" || entry.status === "error"),
        ),
      ),
    listBySyncSecretId: () => Promise.resolve([]),
    listBySyncSecretIds: () => Promise.resolve([]),
    claimForSync: (id, until) => {
      claims.push({ id, until });
      return Promise.resolve(!held.has(id));
    },
    releaseSyncClaim: (id) => {
      released.push(id);
      return Promise.resolve();
    },
    delete: () => Promise.resolve(0),
    deleteByInstallationId: () => Promise.resolve(0),
  };
  return { repo, held, claims, released };
};

/**
 * A poller harness: one project whose member owns the lent keys, a real
 * cipher, in-memory repos and a fixed clock. `fetchImpl` serves GitHub;
 * Jira syncs go through `deps.syncJira`, which tests replace.
 */
export const createPollHarness = () => {
  const resolver = createResolverHarness(POLL_NOW);
  const projectId = createUuidV7();
  const writerUserId = createUuidV7();
  const buildProject = (ownerIsMember: boolean) =>
    ProjectEntity.create({
      id: projectId,
      name: "Lent key project",
      slug: "lent-key-project",
      gitUrl: "https://github.com/acme/lent-key-project.git",
      createdByUserId: resolver.owner.userId,
      orgId: createUuidV7(),
      memberships: [
        ...(ownerIsMember
          ? [{ projectId, userId: resolver.owner.userId, role: "read" }]
          : []),
        { projectId, userId: writerUserId, role: "write" },
      ],
    });
  let project = buildProject(true);
  const projectRepo: ProjectRepo = {
    load: (id) => Promise.resolve(id === projectId ? project : null),
    loadForUpdate: (id) => Promise.resolve(id === projectId ? project : null),
    loadMany: () => Promise.resolve([]),
    listByUser: () => Promise.resolve([]),
    loadByOrgAndSlug: () => Promise.resolve(null),
    listSlugsByOrg: () => Promise.resolve([]),
    create: (entity) => Promise.resolve(entity),
    save: (entity) => Promise.resolve(entity),
  };
  const ownerLeavesProject = () => {
    project = buildProject(false);
  };
  const notifications = fakeAutoSyncPausedNotifications(
    projectRepo,
    new Map([[resolver.owner.userId, "alice"]]),
  );

  const stored = new Map<UuidV7, ProjectIntegrationEntity>();
  const integrationRepo = makeRepo(stored);
  const base = baseDeps();
  const deps: PollLentKeyIntegrationsDeps = {
    projectIntegrationRepo: integrationRepo.repo,
    projectRepo,
    workItemRepo: base.workItemRepo,
    workItemBlockRepo: base.workItemBlockRepo,
    workItemEvents: base.workItemEvents,
    githubRelationshipPendingRefRepo: base.githubRelationshipPendingRefRepo,
    secretRepo: resolver.deps.secretRepo,
    secretCipher: resolver.deps.secretCipher,
    notifications: notifications.deps,
    timeProvider: resolver.deps.timeProvider,
    dbExecutor: fakeDbExecutor(),
    fetchImpl: githubFetch().fetchImpl,
  };

  const saveJiraKey = (name = "Team Jira") =>
    resolver.saveSecret(
      {
        kind: "jira_api_key",
        name,
        metadata: { email: "lender@example.com" },
        expiresAt: new Date(POLL_NOW.getTime() + 90 * 86_400_000),
      },
      "jira-token-ABCD",
    );

  const saveGitHubToken = (name = "Team GitHub") =>
    resolver.saveSecret(
      {
        kind: "github_token",
        name,
        metadata: { login: "lender" },
        expiresAt: null,
      },
      "ghp_token_WXYZ",
    );

  const add = <T extends ProjectIntegrationEntity>(integration: T): T => {
    stored.set(integration.id, integration);
    return integration;
  };

  const addJira = (key: SecretEntity) =>
    add(
      JiraProjectIntegration.rehydrate({
        ...baseProps(projectId, key.id),
        scope: {
          baseUrl: "https://acme.atlassian.net",
          projectKeys: ["ACME"],
        },
      }),
    );

  const addGitHub = (key: SecretEntity, repos: string[]) =>
    add(
      GitHubTokenProjectIntegration.rehydrate({
        ...baseProps(projectId, key.id),
        scope: {
          repos: repos.map((fullName, index) => ({ id: index + 1, fullName })),
        },
      }),
    );

  const current = (id: UuidV7): ProjectIntegrationEntity => {
    const integration = stored.get(id);
    if (!integration) throw new Error(`No integration ${id}`);
    return integration;
  };

  const lastUsedAt = async (key: SecretEntity) =>
    (await resolver.deps.secretRepo.findById(key.id))?.lastUsedAt ?? null;

  return {
    deps,
    held: integrationRepo.held,
    claims: integrationRepo.claims,
    released: integrationRepo.released,
    saveJiraKey,
    saveGitHubToken,
    addJira,
    addGitHub,
    current,
    lastUsedAt,
    ownerUserId: resolver.owner.userId,
    writerUserId,
    ownerLeavesProject,
    notifications: notifications.created,
  };
};

/**
 * A GitHub `fetch` stub: `byRepo` decides each repo's issues response (an
 * empty healthy list by default) and records the repos requested.
 */
export const githubFetch = (
  byRepo: Record<string, () => Response> = {},
): { fetchImpl: typeof fetch; requestedRepos: string[] } => {
  const requestedRepos: string[] = [];
  const fetchImpl = ((input: string | URL | Request) => {
    const url = toRequestUrl(input);
    if (url.includes("/graphql")) {
      return Promise.resolve(jsonResponse({ data: {} }));
    }
    const repo = /\/repos\/([^/]+\/[^/]+)\/issues/.exec(url)?.[1] ?? "";
    requestedRepos.push(repo);
    const respond = byRepo[repo];
    return Promise.resolve(respond ? respond() : jsonResponse([]));
  }) as unknown as typeof fetch;
  return { fetchImpl, requestedRepos };
};

export const githubResponse = (
  status: number,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify({ message: "nope" }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

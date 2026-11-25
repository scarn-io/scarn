import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  runProjectIntegrationSync,
  DEFAULT_FIRST_SYNC_HORIZON_DAYS,
  OVERLAP_WINDOW_MS,
} from "@/integrations/github-ingest/application/run-project-integration-sync";
import {
  GitHubAppProjectIntegration,
  ProjectIntegrationEntity,
  isGitHubAppIntegration,
} from "@/integrations/project-integration/domain/project-integration-entity";
import type { ProjectIntegrationRepo } from "@/integrations/project-integration/application/project-integration-repo";
import { systemTimeProvider } from "@/lib/time-provider";
import type { UserAuthorizationService } from "@/access/authorization/application/user-authorization-service";
import type { WorkItemRepo } from "@/work-items/work-item/application/work-item-repo";
import type { SecretRepo } from "@/secrets/secret/application/secret-repo";
import type { SecretCipher } from "@/secrets/secret/application/secret-cipher";
import type { Logger } from "@scarn/observability/logging";
import { parseUuidV7, createUuidV7 } from "@/common/contracts/uuid-v7";
import { fixedTimeProvider } from "tests/utils";
import * as relationshipsSupport from "./ingest-github-issue-relationships-test-support";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const projectId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f02");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const makeUserAuthz = (): UserAuthorizationService => ({
  actorId: projectId,
  requireProjectMember: () => Promise.reject(new Error("unused")),
  requireProjectPermission: () =>
    Promise.resolve({ membership: null, isPublicNonMemberGrant: false }),
});

/**
 * Minimal fake `WorkItemRepo`/`WorkItemBlockRepo` — this suite's fixtures
 * carry no `parent`/`blockedBy` data worth resolving, so
 * `ingestGitHubIssueRelationships` (invoked by `runProjectIntegrationSync`
 * alongside `ingestGitHubIssues`) never resolves any referenced work item
 * and these repos' mutating methods are never reached.
 */
const makeWorkItemRepo = (): WorkItemRepo => ({
  load: () => Promise.resolve(null),
  loadMany: () => Promise.resolve([]),
  listChildren: () => Promise.resolve([]),
  countSpawnedByTask: () => Promise.resolve(0),
  maxSourceUpdatedAt: () => Promise.resolve(null),
  listPageByProjectId: () => Promise.resolve({ items: [], total: 0 }),
  listFieldOptions: () => Promise.resolve([]),
  listLabels: () => Promise.resolve([]),
  loadByPlatformIdentity: () => Promise.resolve(null),
  loadManyByPlatformIdentities: () => Promise.resolve([]),
  create: (workItem) => Promise.resolve(workItem),
  createMany: (workItems) => Promise.resolve(workItems),
  save: (workItem) => Promise.resolve(workItem),
  saveDescription: (workItem) => Promise.resolve(workItem),
  saveMany: (workItems) => Promise.resolve(workItems),
  saveManyIfSourceNewer: (workItems) => Promise.resolve(workItems),
  setStateMany: (workItems) => Promise.resolve(workItems),
  delete: () => Promise.resolve(0),
  deleteMany: () => Promise.resolve(0),
  deleteByProjectId: () => Promise.resolve(0),
});

const makeIntegrationRepo = (
  integration: ProjectIntegrationEntity,
): { repo: ProjectIntegrationRepo; saved: ProjectIntegrationEntity[] } => {
  const saved: ProjectIntegrationEntity[] = [];
  let stored = integration;
  const repo: ProjectIntegrationRepo = {
    create(entity) {
      stored = entity;
      return Promise.resolve(entity);
    },
    save(entity) {
      stored = entity;
      saved.push(entity);
      return Promise.resolve(entity);
    },
    findById(id) {
      return Promise.resolve(stored.id === id ? stored : null);
    },
    listByProjectId() {
      return Promise.resolve([stored]);
    },
    findByInstallationId() {
      return Promise.resolve([stored].filter(isGitHubAppIntegration));
    },
    listActive() {
      return Promise.resolve([stored]);
    },
    delete() {
      return Promise.resolve(1);
    },
    deleteByInstallationId() {
      return Promise.resolve(1);
    },
  };
  return { repo, saved };
};

type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const jsonResponse = (
  body: JsonValue,
  init: { status?: number } = {},
): Response =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });

const toRequestUrl = (input: string | URL | Request): string =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;

const makeIssue = (id: number, updatedAt: string): JsonValue => ({
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

/** Serves a canned installation token + per-repo canned issue lists, recording every URL requested. */
const makeFetchImpl = (
  issuesByRepo: Record<string, JsonValue[]>,
): { fetchImpl: typeof fetch; calls: string[] } => {
  const calls: string[] = [];
  const fetchImpl = ((input: string | URL | Request) => {
    const url = toRequestUrl(input);
    calls.push(url);
    if (url.includes("/access_tokens")) {
      return Promise.resolve(
        jsonResponse({
          token: "installation-token",
          expires_at: "2026-05-24T13:00:00Z",
        }),
      );
    }
    if (url.includes("/graphql")) {
      // None of this suite's fixtures carry `blockedBy` data worth
      // resolving; an empty `data` payload is enough for
      // `fetchIssueRelationshipsBatch` to report no relationships for any
      // issue.
      return Promise.resolve(jsonResponse({ data: {} }));
    }
    const repoFullName = /\/repos\/([^/]+\/[^/]+)\/issues/.exec(url)?.[1] ?? "";
    return Promise.resolve(jsonResponse(issuesByRepo[repoFullName] ?? []));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
};

const sinceParamFor = (
  calls: string[],
  repoFullName: string,
): string | null => {
  const url = calls.find((u) => u.includes(`/repos/${repoFullName}/issues`));
  return url ? new URL(url).searchParams.get("since") : null;
};

const unusedDependency = (name: string): object =>
  new Proxy(
    {},
    {
      get() {
        throw new Error(`Unexpected call to unused dependency: ${name}`);
      },
    },
  );

const unusedSecretRepo = unusedDependency("secretRepo") as SecretRepo;
const unusedSecretCipher = unusedDependency("secretCipher") as SecretCipher;

const runSync = (
  integration: ProjectIntegrationEntity,
  repo: ProjectIntegrationRepo,
  overrides: {
    fetchImpl: typeof fetch;
    timeProvider?: ReturnType<typeof fixedTimeProvider>;
    logger?: Logger;
    cause?: "manual" | "scheduled";
  },
) =>
  runProjectIntegrationSync(
    {
      projectId,
      integrationId: integration.id,
      githubApp: { appId: "12345", privateKey },
      cause: overrides.cause ?? "manual",
    },
    {
      userAuthz: makeUserAuthz(),
      projectIntegrationRepo: repo,
      workItemRepo: makeWorkItemRepo(),
      workItemBlockRepo: relationshipsSupport.makeWorkItemBlockRepo().repo,
      workItemEvents: relationshipsSupport.noopWorkItemEvents,
      githubRelationshipPendingRefRepo:
        relationshipsSupport.makeGithubRelationshipPendingRefRepo().repo,
      upsertWorkItems: () => Promise.resolve([]),
      secretRepo: unusedSecretRepo,
      secretCipher: unusedSecretCipher,
      timeProvider: overrides.timeProvider ?? systemTimeProvider,
      fetchImpl: overrides.fetchImpl,
      logger: overrides.logger,
    },
  );

const singleRepoIntegration = (
  extra: { firstSyncHorizonDays?: number; lastSyncedAt?: Date } = {},
): ProjectIntegrationEntity =>
  extra.lastSyncedAt
    ? GitHubAppProjectIntegration.rehydrate({
        id: createUuidV7(),
        projectId,
        installationId: "999",
        scope: { repos: [{ id: 1, fullName: "acme/repo" }] },
        status: "active",
        lastSyncedAt: extra.lastSyncedAt,
        lastError: null,
        firstSyncHorizonDays: extra.firstSyncHorizonDays ?? null,
      })
    : ProjectIntegrationEntity.create({
        id: createUuidV7(),
        projectId,
        kind: "github_app",
        installationId: "999",
        scope: { repos: [{ id: 1, fullName: "acme/repo" }] },
        firstSyncHorizonDays: extra.firstSyncHorizonDays,
      });

describe("runProjectIntegrationSync", () => {
  test.concurrent(
    "mints an installation token, ingests, and marks the watermark to the max observed updated_at",
    async () => {
      const integration = singleRepoIntegration();
      const { repo, saved } = makeIntegrationRepo(integration);
      const { fetchImpl, calls } = makeFetchImpl({
        "acme/repo": [makeIssue(1, "2026-05-01T00:00:00Z")],
      });

      const result = await runSync(integration, repo, { fetchImpl });

      expect(result.totalUpserted).toBe(1);
      expect(result.perSource[0]?.key).toBe("acme/repo");
      expect(calls.some((url) => url.includes("/access_tokens"))).toBe(true);
      expect(calls.some((url) => url.includes("/repos/acme/repo/issues"))).toBe(
        true,
      );

      const lastSaved = saved[saved.length - 1];
      expect(lastSaved?.status).toBe("active");
      expect(lastSaved?.lastError).toBeNull();
      // Watermark is the max observed source `updated_at`, not `now()`.
      expect(lastSaved?.lastSyncedAt?.toISOString()).toBe(
        "2026-05-01T00:00:00.000Z",
      );
    },
  );

  test.concurrent(
    "first sync uses now - firstSyncHorizonDays (default 30, overridable per integration)",
    async () => {
      const fixedNow = new Date("2026-06-15T12:00:00.000Z");
      const timeProvider = fixedTimeProvider(fixedNow);

      const defaultIntegration = singleRepoIntegration();
      const { repo: defaultRepo } = makeIntegrationRepo(defaultIntegration);
      const { fetchImpl: defaultFetch, calls: defaultCalls } = makeFetchImpl({
        "acme/repo": [],
      });
      await runSync(defaultIntegration, defaultRepo, {
        fetchImpl: defaultFetch,
        timeProvider,
      });
      const defaultSince = sinceParamFor(defaultCalls, "acme/repo");
      expect(defaultSince).toBe(
        new Date(
          fixedNow.getTime() - DEFAULT_FIRST_SYNC_HORIZON_DAYS * MS_PER_DAY,
        ).toISOString(),
      );

      const overrideIntegration = singleRepoIntegration({
        firstSyncHorizonDays: 7,
      });
      const { repo: overrideRepo } = makeIntegrationRepo(overrideIntegration);
      const { fetchImpl: overrideFetch, calls: overrideCalls } = makeFetchImpl({
        "acme/repo": [],
      });
      await runSync(overrideIntegration, overrideRepo, {
        fetchImpl: overrideFetch,
        timeProvider,
      });
      const overrideSince = sinceParamFor(overrideCalls, "acme/repo");
      expect(overrideSince).toBe(
        new Date(fixedNow.getTime() - 7 * MS_PER_DAY).toISOString(),
      );
      expect(overrideSince).not.toBe(defaultSince);
    },
  );

  test.concurrent(
    "incremental sync computes since from lastSyncedAt minus the overlap window",
    async () => {
      const lastSyncedAt = new Date("2026-06-10T00:00:00.000Z");
      const integration = singleRepoIntegration({ lastSyncedAt });
      const { repo } = makeIntegrationRepo(integration);
      const { fetchImpl, calls } = makeFetchImpl({ "acme/repo": [] });

      await runSync(integration, repo, {
        fetchImpl,
        timeProvider: fixedTimeProvider(new Date("2026-06-15T12:00:00.000Z")),
      });

      expect(sinceParamFor(calls, "acme/repo")).toBe(
        new Date(lastSyncedAt.getTime() - OVERLAP_WINDOW_MS).toISOString(),
      );
    },
  );

  test.concurrent(
    "watermark advances to the max updated_at across multiple repos, not now()",
    async () => {
      const fixedNow = new Date("2026-06-15T12:00:00.000Z");
      const integration = ProjectIntegrationEntity.create({
        id: createUuidV7(),
        projectId,
        kind: "github_app",
        installationId: "999",
        scope: {
          repos: [
            { id: 1, fullName: "acme/repo-a" },
            { id: 2, fullName: "acme/repo-b" },
          ],
        },
      });
      const { repo, saved } = makeIntegrationRepo(integration);
      const { fetchImpl } = makeFetchImpl({
        "acme/repo-a": [makeIssue(1, "2026-05-01T00:00:00Z")],
        "acme/repo-b": [
          makeIssue(2, "2026-05-20T09:30:00Z"),
          makeIssue(3, "2026-05-10T00:00:00Z"),
        ],
      });

      await runSync(integration, repo, {
        fetchImpl,
        timeProvider: fixedTimeProvider(fixedNow),
      });

      const lastSaved = saved[saved.length - 1];
      expect(lastSaved?.lastSyncedAt?.toISOString()).toBe(
        "2026-05-20T09:30:00.000Z",
      );
      expect(lastSaved?.lastSyncedAt?.getTime()).not.toBe(fixedNow.getTime());
    },
  );

  test.concurrent(
    "zero-issues run still advances the watermark to the run's start time",
    async () => {
      const fixedNow = new Date("2026-06-15T12:00:00.000Z");
      const integration = singleRepoIntegration();
      const { repo, saved } = makeIntegrationRepo(integration);
      const { fetchImpl } = makeFetchImpl({ "acme/repo": [] });

      await runSync(integration, repo, {
        fetchImpl,
        timeProvider: fixedTimeProvider(fixedNow),
      });

      const lastSaved = saved[saved.length - 1];
      expect(lastSaved?.lastSyncedAt?.toISOString()).toBe(
        fixedNow.toISOString(),
      );
    },
  );

  test.concurrent(
    "marks the integration as errored on failure, leaves the watermark unchanged, and threads cause into the log",
    async () => {
      const priorSyncedAt = new Date("2026-01-01T00:00:00.000Z");
      const integration = singleRepoIntegration({
        lastSyncedAt: priorSyncedAt,
      });
      const { repo, saved } = makeIntegrationRepo(integration);

      const fetchImpl = (() =>
        Promise.resolve(
          jsonResponse({ message: "Bad credentials" }, { status: 401 }),
        )) as unknown as typeof fetch;

      const errorLogCalls: unknown[][] = [];
      const logger = {
        error: (...args: unknown[]) => errorLogCalls.push(args),
      } as unknown as Logger;

      let caught: unknown = null;
      try {
        await runSync(integration, repo, {
          fetchImpl,
          logger,
          cause: "scheduled",
        });
      } catch (error: unknown) {
        caught = error;
      }

      expect(caught).not.toBeNull();
      const lastSaved = saved[saved.length - 1];
      expect(lastSaved?.status).toBe("error");
      expect(lastSaved?.lastError).toBeTruthy();
      expect(lastSaved?.lastSyncedAt?.toISOString()).toBe(
        priorSyncedAt.toISOString(),
      );

      expect(errorLogCalls).toHaveLength(1);
      const [logContext] = errorLogCalls[0] ?? [];
      const typedContext = logContext as { cause?: string } | undefined;
      expect(typedContext?.cause).toBe("scheduled");
    },
  );
});

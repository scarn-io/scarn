import { afterAll, afterEach, beforeEach } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { createScarnTreaty } from "tests/treaty";
import { fixedTimeProvider, unwrapAsync } from "tests/utils";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";

/**
 * Shared fixtures/harness for `run-project-integration-sync.relationships*
 * .test.ts` — split out of the test files themselves to keep each under the
 * repo's `max-lines` limit, mirroring
 * `ingest-github-issue-relationships-test-support.ts`'s precedent.
 */

export const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

export const RECONCILE_SECRET = "test-github-reconcile-secret-0123456789";

const ENV_KEYS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_RECONCILE_CRON_SECRET",
] as const;

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const jsonResponse = (body: JsonValue): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const toRequestUrl = (input: string | URL | Request): string =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;

export type GitHubIssueRefFixture = {
  owner: string;
  repo: string;
  number: number;
};

export type GitHubIssueFixture = {
  number: number;
  parentRef?: GitHubIssueRefFixture;
  state?: "open" | "closed";
  labels?: string[];
};

const makeRawIssue = (
  repoFullName: string,
  fixture: GitHubIssueFixture,
): JsonValue => ({
  id: fixture.number,
  node_id: `I_${String(fixture.number)}`,
  number: fixture.number,
  title: `Issue ${String(fixture.number)}`,
  body: "Repro",
  html_url: `https://github.com/${repoFullName}/issues/${String(fixture.number)}`,
  state: fixture.state ?? "open",
  state_reason: fixture.state === "closed" ? "completed" : null,
  user: { login: "alice" },
  labels: (fixture.labels ?? []).map((name) => ({ name })),
  assignees: [],
  comments: 0,
  created_at: "2026-04-01T00:00:00Z",
  updated_at: "2026-04-01T00:00:00Z",
  closed_at: fixture.state === "closed" ? "2026-04-01T00:00:00Z" : null,
});

/**
 * Serves a canned installation token, a single repo's REST issue list, and
 * the GraphQL `parent`/`blockedBy` batch response for that same repo (with
 * each issue's `parent` set per fixture). Assumes a single repo/single
 * GraphQL batch (this suite's fixtures are well under
 * `GITHUB_RELATIONSHIP_BATCH_SIZE`), so every issue lands under the `r0`
 * alias at the index matching its position in `issues`.
 */
export const makeRelationshipsFetchImpl = (opts: {
  repoFullName: string;
  issues: GitHubIssueFixture[];
  blockedByByNumber?: Record<number, GitHubIssueRefFixture[]>;
}): typeof fetch => {
  const indexByNumber = new Map(
    opts.issues.map((issue, index) => [issue.number, index]),
  );
  return ((input: string | URL | Request) => {
    const url = toRequestUrl(input);
    if (url.includes("/access_tokens")) {
      return Promise.resolve(
        jsonResponse({
          token: "installation-token",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }),
      );
    }
    if (url.includes("/graphql")) {
      const issueFields: Record<string, JsonValue> = {};
      for (const issue of opts.issues) {
        const index = indexByNumber.get(issue.number);
        const refs = opts.blockedByByNumber?.[issue.number] ?? [];
        const parent = issue.parentRef;
        issueFields[`i${String(index)}`] = {
          parent: parent
            ? {
                number: parent.number,
                repository: {
                  owner: { login: parent.owner },
                  name: parent.repo,
                },
              }
            : null,
          blockedBy: {
            nodes: refs.map((ref) => ({
              number: ref.number,
              repository: { owner: { login: ref.owner }, name: ref.repo },
            })),
          },
        };
      }
      return Promise.resolve(jsonResponse({ data: { r0: issueFields } }));
    }
    if (url.includes("/issues")) {
      // The scheduled-reconcile test's sweep syncs every active integration
      // in the shared database, including other files' on sibling
      // `--parallel` workers. Other repos get an empty issue list: serving
      // them this repo's fixtures would overwrite their work items, and an
      // error would flip their integration to `error`.
      if (!url.includes(`/repos/${opts.repoFullName}/issues`)) {
        return Promise.resolve(jsonResponse([]));
      }
      return Promise.resolve(
        jsonResponse(
          opts.issues.map((issue) => makeRawIssue(opts.repoFullName, issue)),
        ),
      );
    }
    throw new Error(`Unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;
};

/**
 * Registers `beforeEach`/`afterEach` hooks that stub the GitHub App +
 * reconcile-cron env vars for the duration of each test and restore
 * `globalThis.fetch` afterward. Must be called synchronously inside the
 * consuming file's top-level `describe` callback, exactly like calling
 * `beforeEach`/`afterEach` directly would be.
 *
 * Mutates `process.env` and `globalThis.fetch` — process-global shared
 * state — so any file using this harness must run its tests serially (plain
 * `test`, not `test.concurrent`).
 */
export const useGithubRelationshipsTestEnv = (): void => {
  let savedEnv: Record<string, string | undefined> = {};
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    process.env["GITHUB_APP_ID"] = "test-app-id";
    process.env["GITHUB_APP_SLUG"] = "test-app-slug";
    process.env["GITHUB_APP_PRIVATE_KEY"] = privateKey;
    process.env["GITHUB_RECONCILE_CRON_SECRET"] = RECONCILE_SECRET;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = savedEnv[key];
    }
    globalThis.fetch = originalFetch;
  });
};

/**
 * Builds a real (testcontainers-backed) `appContext`/`app`/`apiClient` plus
 * the request helpers shared by every test in this suite. Each consuming
 * file calls this once at the top of its `describe` block.
 *
 * The underlying Postgres container is shared and reused across every
 * *separate* local `bun test` invocation too, not just within one run (see
 * `@scarn/local-dev/test-db`) — so
 * every project this harness creates is tracked and deleted in an
 * `afterAll`, cascading (via `project_integrations`' `onDelete: "cascade"`
 * FK) to the GitHub integration created alongside it. Without this, each
 * local re-run of this suite would leave more permanently-`active` GitHub
 * integrations behind, and the next run's scheduled-reconciliation test
 * would have `reconcileActiveIntegrations`'s global, unscoped `listActive()`
 * sweep pick up every prior run's leftovers too — each of which fails this
 * test's single-repo `globalThis.fetch` mock, inflating `integrationsFailed`
 * (see `drizzle-project-integration-repo.test.ts`'s `deleteProject` for the
 * same pattern applied to a different suite).
 */
export const createRelationshipsTestHarness = () => {
  const appContext = createAppContext({
    timeProvider: fixedTimeProvider(new Date("2026-04-22T12:00:00.000Z")),
  });
  const app = createApp(appContext);
  const apiClient = createScarnTreaty(app);

  const createdProjectIds: UuidV7[] = [];
  afterAll(async () => {
    for (const projectId of createdProjectIds) {
      await getDb().delete(projects).where(eq(projects.id, projectId));
    }
  });

  const createProjectWithGitHubIntegration = async (
    owner: { authHeaders: { authorization: string } },
    projectName: string,
    repoFullName: string,
  ): Promise<{ project: ProjectContract; integrationId: string }> => {
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: projectName,
          description: `Project for ${projectName}`,
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    createdProjectIds.push(parseUuidV7(project.id));

    const integration = await unwrapAsync(
      apiClient.api.projects({ projectId: project.id }).integrations.post(
        {
          kind: "github_app",
          installationId: "999",
          externalScope: { repos: [{ id: 1, fullName: repoFullName }] },
        },
        { headers: { ...owner.authHeaders } },
      ),
    );

    return { project, integrationId: integration.id };
  };

  const runSync = (
    projectId: string,
    integrationId: string,
    headers: { authorization: string },
  ) =>
    unwrapAsync(
      apiClient.api
        .projects({ projectId })
        .integrations({ integrationId })
        .sync.post(undefined, { headers }),
    );

  const loadSyncedWorkItem = async (
    projectId: string,
    repoFullName: string,
    number: number,
  ) => {
    const items = await appContext.workItemRepo.loadManyByPlatformIdentities([
      {
        projectId: parseUuidV7(projectId),
        platform: "github",
        sourceIdentity: `${repoFullName}#${String(number)}`,
      },
    ]);
    const item = items[0];
    if (!item) {
      throw new Error(
        `Expected a synced work item for ${repoFullName}#${String(number)}`,
      );
    }
    return item;
  };

  return {
    appContext,
    app,
    apiClient,
    createProjectWithGitHubIntegration,
    runSync,
    loadSyncedWorkItem,
  };
};

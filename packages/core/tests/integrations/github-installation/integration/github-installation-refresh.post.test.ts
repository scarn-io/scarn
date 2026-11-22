import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { createTestUserAndSession } from "@scarn/identity/testing";
import { createScarnTreaty } from "tests/treaty";
import { GitHubInstallationEntity } from "@/integrations/github-installation/domain/github-installation-entity";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const toRequestUrl = (input: string | URL | Request): string =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;

type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const jsonResponse = (body: JsonValue, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const makeGithubApiFetchMock = (
  repos: { id: number; fullName: string }[],
): typeof fetch =>
  ((input: string | URL | Request) => {
    const url = toRequestUrl(input);
    if (url.endsWith("/access_tokens")) {
      return Promise.resolve(
        jsonResponse({
          token: "test-installation-token",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }),
      );
    }
    if (/\/app\/installations\/[^/]+$/.test(url)) {
      return Promise.resolve(
        jsonResponse({
          account: { login: "connorivy", type: "User" },
          repository_selection: "selected",
        }),
      );
    }
    if (url.includes("/installation/repositories")) {
      return Promise.resolve(
        jsonResponse({
          repositories: repos.map((repo) => ({
            id: repo.id,
            full_name: repo.fullName,
          })),
        }),
      );
    }
    throw new Error(`Unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;

/**
 * Mutates `process.env` (GitHub App config) and `globalThis.fetch` (the live
 * GitHub API call this route makes) — process-global shared state — so this
 * suite runs serially (plain `test`, not `test.concurrent`) rather than
 * risking cross-test interleaving. See docs/testing.md's carve-out for
 * order-dependent/shared-state suites.
 */
describe("POST /integrations/github/installations/:installationId/refresh", () => {
  const appContext = createAppContext();
  const app = createApp(appContext);

  const GITHUB_ENV_KEYS = [
    "GITHUB_APP_ID",
    "GITHUB_APP_SLUG",
    "GITHUB_APP_PRIVATE_KEY",
  ] as const;
  let savedEnv: Record<string, string | undefined> = {};
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    savedEnv = {};
    for (const key of GITHUB_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      Reflect.deleteProperty(process.env, key);
    }
  });

  afterEach(() => {
    for (const key of GITHUB_ENV_KEYS) {
      if (savedEnv[key] === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = savedEnv[key];
    }
    globalThis.fetch = originalFetch;
  });

  test("returns 401 when the request is unauthenticated", async () => {
    const apiClient = createScarnTreaty(app);
    const { data, error } = await apiClient.api.integrations.github
      .installations({ installationId: "does-not-matter" })
      .refresh.post();

    expect(data).toBeNull();
    expect(error?.status).toBe(401);
  });

  test("returns 400 when the GitHub App is not configured", async () => {
    const apiClient = createScarnTreaty(app);
    const owner = await createTestUserAndSession({
      email: `refresh-not-configured-${crypto.randomUUID()}@example.com`,
    });

    const authed = await apiClient.api.integrations.github
      .installations({ installationId: "does-not-matter" })
      .refresh.post(undefined, { headers: { ...owner.authHeaders } });

    expect(authed.data).toBeNull();
    expect(authed.error?.status).toBe(400);
    expect(authed.error?.value).toMatchObject({
      code: "GITHUB_APP_NOT_CONFIGURED",
    });
  });

  test("returns 403 when the installation does not exist", async () => {
    process.env["GITHUB_APP_ID"] = "test-app-id";
    process.env["GITHUB_APP_SLUG"] = "test-app-slug";
    process.env["GITHUB_APP_PRIVATE_KEY"] = privateKey;

    const apiClient = createScarnTreaty(app);
    const owner = await createTestUserAndSession({
      email: `refresh-missing-${crypto.randomUUID()}@example.com`,
    });

    const { data, error } = await apiClient.api.integrations.github
      .installations({ installationId: `nonexistent-${crypto.randomUUID()}` })
      .refresh.post(undefined, { headers: { ...owner.authHeaders } });

    expect(data).toBeNull();
    expect(error?.status).toBe(403);
    expect(error?.value).toMatchObject({
      code: "GITHUB_INSTALLATION_NOT_OWNED",
    });
  });

  test("returns 403 when the installation belongs to another user", async () => {
    process.env["GITHUB_APP_ID"] = "test-app-id";
    process.env["GITHUB_APP_SLUG"] = "test-app-slug";
    process.env["GITHUB_APP_PRIVATE_KEY"] = privateKey;

    const apiClient = createScarnTreaty(app);
    const owner = await createTestUserAndSession({
      email: `refresh-owner-${crypto.randomUUID()}@example.com`,
    });
    const requester = await createTestUserAndSession({
      email: `refresh-requester-${crypto.randomUUID()}@example.com`,
    });

    const installationId = `refresh-not-owned-${crypto.randomUUID()}`;
    await appContext.githubInstallationRepo.upsert(
      GitHubInstallationEntity.create({
        installationId,
        accountLogin: "connorivy",
        accountType: "User",
        targetType: "selected",
        selectedRepositories: [{ id: 1, fullName: "scarn-io/scarn" }],
        installedByUserId: parseUuidV7(owner.userId),
      }),
    );

    const { data, error } = await apiClient.api.integrations.github
      .installations({ installationId })
      .refresh.post(undefined, { headers: { ...requester.authHeaders } });

    expect(data).toBeNull();
    expect(error?.status).toBe(403);
    expect(error?.value).toMatchObject({
      code: "GITHUB_INSTALLATION_NOT_OWNED",
    });
  });

  test("refreshes the repo list from a live GitHub fetch for an owned installation", async () => {
    process.env["GITHUB_APP_ID"] = "test-app-id";
    process.env["GITHUB_APP_SLUG"] = "test-app-slug";
    process.env["GITHUB_APP_PRIVATE_KEY"] = privateKey;
    globalThis.fetch = makeGithubApiFetchMock([
      { id: 1, fullName: "scarn-io/scarn" },
      { id: 2, fullName: "connorivy/voc-viewer" },
    ]);

    const apiClient = createScarnTreaty(app);
    const owner = await createTestUserAndSession({
      email: `refresh-success-${crypto.randomUUID()}@example.com`,
    });

    const installationId = `refresh-success-${crypto.randomUUID()}`;
    await appContext.githubInstallationRepo.upsert(
      GitHubInstallationEntity.create({
        installationId,
        accountLogin: "connorivy",
        accountType: "User",
        targetType: "selected",
        selectedRepositories: [{ id: 1, fullName: "scarn-io/scarn" }],
        installedByUserId: parseUuidV7(owner.userId),
      }),
    );

    const { data, error } = await apiClient.api.integrations.github
      .installations({ installationId })
      .refresh.post(undefined, { headers: { ...owner.authHeaders } });

    expect(error).toBeNull();
    expect(data).toEqual({
      installationId,
      accountLogin: "connorivy",
      repos: [
        { id: 1, fullName: "scarn-io/scarn" },
        { id: 2, fullName: "connorivy/voc-viewer" },
      ],
    });

    const persisted =
      await appContext.githubInstallationRepo.findByInstallationId(
        installationId,
      );
    expect(persisted?.selectedRepositories).toEqual([
      { id: 1, fullName: "scarn-io/scarn" },
      { id: 2, fullName: "connorivy/voc-viewer" },
    ]);
  });
});

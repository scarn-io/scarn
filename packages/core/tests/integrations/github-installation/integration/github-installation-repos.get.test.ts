import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { createTestUserAndSession } from "@scarn/identity/testing";
import { createScarnTreaty } from "tests/treaty";
import { GitHubInstallationEntity } from "@/integrations/github-installation/domain/github-installation-entity";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";

/**
 * `GET /integrations/github/repos` reads process-level GitHub App config
 * (`getGitHubAppConfig()`) and no test in this repo sets `GITHUB_APP_ID` by
 * default, so these tests mutate `process.env` to exercise both the
 * "configured" and "unconfigured" branches. Kept serial (plain `test`, not
 * `test.concurrent`) because that mutation is process-global shared state —
 * see docs/testing.md's carve-out for order-dependent/shared-state suites.
 */
describe("GET /integrations/github/repos", () => {
  const appContext = createAppContext();
  const app = createApp(appContext);

  const GITHUB_ENV_KEYS = [
    "GITHUB_APP_ID",
    "GITHUB_APP_SLUG",
    "GITHUB_APP_PRIVATE_KEY",
  ] as const;
  let savedEnv: Record<string, string | undefined> = {};

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
  });

  test("returns 401 when the request is unauthenticated", async () => {
    const apiClient = createScarnTreaty(app);
    const { data, error } = await apiClient.api.integrations.github.repos.get();

    expect(data).toBeNull();
    expect(error?.status).toBe(401);
  });

  test("returns 400 when the GitHub App is not configured", async () => {
    const apiClient = createScarnTreaty(app);
    const owner = await createTestUserAndSession({
      email: `no-github-app-${crypto.randomUUID()}@example.com`,
    });

    const { data, error } = await apiClient.api.integrations.github.repos.get({
      headers: { ...owner.authHeaders },
    });

    expect(data).toBeNull();
    expect(error?.status).toBe(400);
    expect(error?.value).toMatchObject({ code: "GITHUB_APP_NOT_CONFIGURED" });
  });

  test("returns [] when the user has no installations", async () => {
    process.env["GITHUB_APP_ID"] = "test-app-id";
    process.env["GITHUB_APP_SLUG"] = "test-app-slug";

    const apiClient = createScarnTreaty(app);
    const owner = await createTestUserAndSession({
      email: `no-installations-${crypto.randomUUID()}@example.com`,
    });

    const { data, error } = await apiClient.api.integrations.github.repos.get({
      headers: { ...owner.authHeaders },
    });

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  test("returns only the cached repo lists for installations this user owns", async () => {
    process.env["GITHUB_APP_ID"] = "test-app-id";
    process.env["GITHUB_APP_SLUG"] = "test-app-slug";

    const apiClient = createScarnTreaty(app);
    const owner = await createTestUserAndSession({
      email: `owner-${crypto.randomUUID()}@example.com`,
    });
    const someoneElse = await createTestUserAndSession({
      email: `someone-else-${crypto.randomUUID()}@example.com`,
    });

    const installationId = `repos-get-${crypto.randomUUID()}`;
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
    const otherInstallationId = `repos-get-other-${crypto.randomUUID()}`;
    await appContext.githubInstallationRepo.upsert(
      GitHubInstallationEntity.create({
        installationId: otherInstallationId,
        accountLogin: "not-me",
        accountType: "User",
        targetType: "all",
        selectedRepositories: [{ id: 2, fullName: "not-me/private-repo" }],
        installedByUserId: parseUuidV7(someoneElse.userId),
      }),
    );

    const { data, error } = await apiClient.api.integrations.github.repos.get({
      headers: { ...owner.authHeaders },
    });

    expect(error).toBeNull();
    expect(data).toEqual([
      {
        installationId,
        accountLogin: "connorivy",
        repos: [{ id: 1, fullName: "scarn-io/scarn" }],
      },
    ]);
  });
});

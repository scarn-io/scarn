import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { createScarnTreaty } from "tests/treaty";
import { fixedTimeProvider, unwrapAsync } from "tests/utils";
import {
  createSecretsTestUser,
  githubTokenInput,
  SECRETS_TEST_NOW,
} from "tests/secrets/secret/integration/secret-test-support";
import {
  countSecretsFor,
  createGitHubEnvGuard,
  installGitHubFetchStub,
  loadSecretLastUsedAt,
} from "./project-setup-test-support";

const GIT_URL = "https://github.com/acme/api.git";

/**
 * `POST /projects` with a GitHub token: access is checked before anything
 * is written, the token is never saved, and a failed first sync keeps the
 * project. Replaces `globalThis.fetch`, so tests run serially.
 */
describe("POST /projects — GitHub token issue tracker", () => {
  const apiClient = createScarnTreaty(
    createApp(
      createAppContext({ timeProvider: fixedTimeProvider(SECRETS_TEST_NOW) }),
    ),
  );
  const env = createGitHubEnvGuard();

  beforeEach(env.clear);
  afterEach(env.restore);

  const createWithToken = (
    headers: Record<string, string>,
    credential: Record<string, unknown>,
    gitUrl = GIT_URL,
    firstSyncHorizonDays?: number,
    autoSync?: boolean,
  ) =>
    apiClient.api.projects.post(
      {
        name: "API",
        description: null,
        gitUrl,
        issueTracker: {
          type: "github_token",
          credential,
          firstSyncHorizonDays,
          autoSync,
        } as never,
      },
      { headers },
    );

  const listProjects = (headers: Record<string, string>) =>
    unwrapAsync(apiClient.api.projects.get({ headers }));

  test("a pasted token creates a user_credential integration, reads with Bearer, and saves nothing", async () => {
    const requests = installGitHubFetchStub();
    const owner = await createSecretsTestUser();

    const project = await unwrapAsync(
      createWithToken(owner.authHeaders, { token: "ghp_pasted_1234" }),
    );

    expect(project).toMatchObject({
      gitUrl: GIT_URL,
      initialSyncFailed: false,
    });
    const integrations = await unwrapAsync(
      apiClient.api
        .projects({ projectId: project.id })
        .integrations.get({ headers: owner.authHeaders }),
    );
    expect(integrations).toHaveLength(1);
    expect(integrations[0]).toMatchObject({
      kind: "github_token",
      platform: "github",
      authMode: "user_credential",
      externalScope: { repos: [{ id: 101, fullName: "acme/api" }] },
      status: "active",
    });
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.authorization).toBe("Bearer ghp_pasted_1234");
    }
    expect(requests.map((request) => new URL(request.url).pathname)).toContain(
      "/repos/acme/api",
    );
    expect(await countSecretsFor(owner.userId)).toBe(0);
  });

  test("a saved token is used and marked used", async () => {
    installGitHubFetchStub();
    const owner = await createSecretsTestUser();
    const secret = await unwrapAsync(
      apiClient.api.me.secrets.post(githubTokenInput(), {
        headers: owner.authHeaders,
      }),
    );

    const project = await unwrapAsync(
      createWithToken(owner.authHeaders, { secretId: secret.id }),
    );

    expect(project.initialSyncFailed).toBe(false);
    expect((await loadSecretLastUsedAt(secret.id))?.toISOString()).toBe(
      SECRETS_TEST_NOW.toISOString(),
    );
    expect(await countSecretsFor(owner.userId)).toBe(1);
  });

  test("autoSync with a saved token creates the integration with auto-sync on", async () => {
    installGitHubFetchStub();
    const owner = await createSecretsTestUser();
    const secret = await unwrapAsync(
      apiClient.api.me.secrets.post(githubTokenInput(), {
        headers: owner.authHeaders,
      }),
    );

    const project = await unwrapAsync(
      createWithToken(
        owner.authHeaders,
        { secretId: secret.id },
        GIT_URL,
        undefined,
        true,
      ),
    );

    const integrations = await unwrapAsync(
      apiClient.api
        .projects({ projectId: project.id })
        .integrations.get({ headers: owner.authHeaders }),
    );
    expect(integrations[0]?.autoSync).toMatchObject({
      state: "on",
      syncsAs: { userId: owner.userId },
    });
  });

  test("autoSync with a pasted token is rejected and creates no project", async () => {
    installGitHubFetchStub();
    const owner = await createSecretsTestUser();

    const { data, error } = await createWithToken(
      owner.authHeaders,
      { token: "ghp_pasted_1234" },
      GIT_URL,
      undefined,
      true,
    );

    expect(data).toBeNull();
    expect(error?.status).toBe(422);
    expect(error?.value).toMatchObject({
      code: "PROJECT_INTEGRATION_AUTO_SYNC_NEEDS_SAVED_KEY",
    });
    expect(await listProjects(owner.authHeaders)).toEqual([]);
  });

  test("a shorter first-sync window reaches the integration and GitHub request", async () => {
    const requests = installGitHubFetchStub();
    const owner = await createSecretsTestUser();

    const project = await unwrapAsync(
      createWithToken(
        owner.authHeaders,
        { token: "ghp_pasted_1234" },
        GIT_URL,
        7,
      ),
    );

    expect(project.initialSyncFailed).toBe(false);
    const integrations = await unwrapAsync(
      apiClient.api
        .projects({ projectId: project.id })
        .integrations.get({ headers: owner.authHeaders }),
    );
    expect(integrations[0]?.firstSyncHorizonDays).toBe(7);
    const issueRequest = requests.find((request) =>
      new URL(request.url).pathname.endsWith("/issues"),
    );
    expect(issueRequest).toBeDefined();
    const since = issueRequest
      ? new URL(issueRequest.url).searchParams.get("since")
      : null;
    expect(since).toBe(
      new Date(
        SECRETS_TEST_NOW.getTime() - 7 * 24 * 60 * 60 * 1000,
      ).toISOString(),
    );
  });

  test("a GitHub tracker on a non-GitHub URL is ISSUE_TRACKER_HOST_MISMATCH and calls nothing", async () => {
    const requests = installGitHubFetchStub();
    const owner = await createSecretsTestUser();

    const { data, error } = await createWithToken(
      owner.authHeaders,
      { token: "ghp_pasted_1234" },
      "https://bitbucket.org/acme/api.git",
    );

    expect(data).toBeNull();
    expect(error?.status).toBe(422);
    expect(error?.value).toMatchObject({ code: "ISSUE_TRACKER_HOST_MISMATCH" });
    expect(requests).toEqual([]);
    expect(await listProjects(owner.authHeaders)).toEqual([]);
  });

  test("a repo the token can't read creates no project", async () => {
    installGitHubFetchStub({ repoStatus: 404 });
    const owner = await createSecretsTestUser();

    const { data, error } = await createWithToken(owner.authHeaders, {
      token: "ghp_pasted_1234",
    });

    expect(data).toBeNull();
    expect(error?.status).toBe(422);
    expect(error?.value).toMatchObject({ code: "GITHUB_REPO_NOT_ACCESSIBLE" });
    expect(await listProjects(owner.authHeaders)).toEqual([]);
  });

  test("a rejected token creates no project and doesn't echo the token", async () => {
    installGitHubFetchStub({ repoStatus: 401 });
    const owner = await createSecretsTestUser();

    const { data, error } = await createWithToken(owner.authHeaders, {
      token: "ghp_rejected_9876",
    });

    expect(data).toBeNull();
    expect(error?.status).toBe(400);
    expect(error?.value).toMatchObject({ code: "GITHUB_TOKEN_REJECTED" });
    expect(JSON.stringify(error?.value)).not.toContain("ghp_rejected_9876");
    expect(await listProjects(owner.authHeaders)).toEqual([]);
  });

  test("a failed first sync keeps the project and sets initialSyncFailed", async () => {
    installGitHubFetchStub({ issuesStatus: 500 });
    const owner = await createSecretsTestUser();

    const project = await unwrapAsync(
      createWithToken(owner.authHeaders, { token: "ghp_pasted_1234" }),
    );

    expect(project.initialSyncFailed).toBe(true);
    const integrations = await unwrapAsync(
      apiClient.api
        .projects({ projectId: project.id })
        .integrations.get({ headers: owner.authHeaders }),
    );
    expect(integrations[0]?.status).toBe("error");
    expect(integrations[0]?.lastError).toBeTruthy();
  });

  test("another user's saved token is a 404 and calls nothing", async () => {
    const requests = installGitHubFetchStub();
    const owner = await createSecretsTestUser();
    const stranger = await createSecretsTestUser();
    const secret = await unwrapAsync(
      apiClient.api.me.secrets.post(githubTokenInput(), {
        headers: stranger.authHeaders,
      }),
    );

    const { data, error } = await createWithToken(owner.authHeaders, {
      secretId: secret.id,
    });

    expect(data).toBeNull();
    expect(error?.status).toBe(404);
    expect(requests).toEqual([]);
    expect(await listProjects(owner.authHeaders)).toEqual([]);
  });
});

import { afterEach, describe, expect, mock, test } from "bun:test";
import { unwrapAsync } from "tests/utils";
import {
  bitbucketApiTokenInput,
  createSecretsTestUser,
  githubTokenInput,
  jiraApiKeyInput,
} from "tests/secrets/secret/integration/secret-test-support";
import { uninstallJiraIssuesClientMock } from "tests/integrations/github-ingest/integration/jira-issues-client-mock-support";
import { createGitHubEnvGuard } from "tests/projects/project/integration/project-setup-test-support";
import { setUpAutoSyncTest } from "./auto-sync-route-test-support";

const githubTokenIntegrationInput = {
  kind: "github_token",
  externalScope: {
    repos: [
      { id: 1, fullName: "acme/api" },
      { id: 2, fullName: "acme/web" },
    ],
  },
};

describe("PUT/DELETE /projects/:projectId/integrations/:integrationId/auto-sync — GitHub", () => {
  const env = createGitHubEnvGuard();

  afterEach(async () => {
    env.restore();
    await uninstallJiraIssuesClientMock();
    mock.restore();
  });

  const setUp = async (githubRepoStatuses: Record<string, number> = {}) => {
    env.clear();
    const ctx = await setUpAutoSyncTest({ githubRepoStatuses });
    const integration = await ctx.createIntegration(
      githubTokenIntegrationInput,
    );
    return { ...ctx, integration };
  };

  test("lending a GitHub token checks every repo, then turns auto-sync on", async () => {
    const { owner, integration, createSecret, enable, githubRequests } =
      await setUp();
    const secret = await createSecret(
      githubTokenInput({ value: "ghp_owner_token" }),
    );

    const result = await unwrapAsync(enable(integration.id, secret.id));

    expect(result.autoSync).toMatchObject({
      supported: true,
      state: "on",
      syncsAs: { userId: owner.userId, secretName: secret.name },
    });
    expect(githubRequests).toEqual([
      { path: "/repos/acme/api", authorization: "Bearer ghp_owner_token" },
      { path: "/repos/acme/web", authorization: "Bearer ghp_owner_token" },
    ]);
    expect(JSON.stringify(result)).not.toContain("ghp_owner_token");
  });

  test("a rejected GitHub token is GITHUB_TOKEN_REJECTED and nothing is saved", async () => {
    const { integration, createSecret, enable, loadIntegration } = await setUp({
      "acme/api": 401,
    });
    const secret = await createSecret(githubTokenInput());

    const { error } = await enable(integration.id, secret.id);

    expect(error?.status).toBe(400);
    expect(error?.value).toMatchObject({ code: "GITHUB_TOKEN_REJECTED" });
    expect((await loadIntegration(integration.id))?.autoSync.state).toBe("off");
  });

  test("a token missing access to one repo is rejected naming the repo", async () => {
    const { integration, createSecret, enable, loadIntegration } = await setUp({
      "acme/web": 404,
    });
    const secret = await createSecret(githubTokenInput());

    const { error } = await enable(integration.id, secret.id);

    expect(error?.status).toBe(422);
    expect(error?.value).toMatchObject({ code: "GITHUB_REPO_NOT_ACCESSIBLE" });
    expect(JSON.stringify(error?.value)).toContain("acme/web");
    expect((await loadIntegration(integration.id))?.autoSync.state).toBe("off");
  });

  test("another user's secret 404s without calling GitHub", async () => {
    const { integration, createSecret, enable, githubRequests } = await setUp();
    const stranger = await createSecretsTestUser();
    const strangerSecret = await createSecret(
      githubTokenInput(),
      stranger.authHeaders,
    );

    const { error } = await enable(integration.id, strangerSecret.id);

    expect(error?.status).toBe(404);
    expect(githubRequests).toHaveLength(0);
  });

  test("a secret of the wrong kind is SECRET_KIND_MISMATCH", async () => {
    const { integration, createSecret, enable, githubRequests } = await setUp();
    const secret = await createSecret(jiraApiKeyInput());

    const { error } = await enable(integration.id, secret.id);

    expect(error?.status).toBe(400);
    expect(error?.value).toMatchObject({ code: "SECRET_KIND_MISMATCH" });
    expect(githubRequests).toHaveLength(0);
  });

  test("a teammate taking over replaces the lent token", async () => {
    const { teammate, integration, createSecret, enable } = await setUp();
    const ownerSecret = await createSecret(githubTokenInput());
    const teammateSecret = await createSecret(
      githubTokenInput(),
      teammate.authHeaders,
    );
    await unwrapAsync(enable(integration.id, ownerSecret.id));

    const result = await unwrapAsync(
      enable(integration.id, teammateSecret.id, teammate.authHeaders),
    );

    expect(result.autoSync.syncsAs).toMatchObject({
      userId: teammate.userId,
      secretName: teammateSecret.name,
    });
  });

  test("a github_app or bitbucket integration can't auto-sync, whatever the secret", async () => {
    const { createIntegration, createSecret, enable, githubRequests } =
      await setUp();
    const bitbucket = await createIntegration({
      kind: "bitbucket",
      externalScope: {
        repos: [{ workspace: "acme", slug: "api", fullName: "acme/api" }],
      },
    });
    const githubApp = await createIntegration({
      kind: "github_app",
      installationId: "12345",
      externalScope: { repos: [{ id: 1, fullName: "acme/api" }] },
    });
    const bitbucketSecret = await createSecret(bitbucketApiTokenInput());
    const githubSecret = await createSecret(githubTokenInput());

    const bitbucketResult = await enable(bitbucket.id, bitbucketSecret.id);
    const githubAppResult = await enable(githubApp.id, githubSecret.id);

    for (const { error } of [bitbucketResult, githubAppResult]) {
      expect(error?.status).toBe(400);
      expect(error?.value).toMatchObject({
        code: "PROJECT_INTEGRATION_AUTO_SYNC_UNSUPPORTED",
      });
    }
    expect(githubRequests).toHaveLength(0);
  });

  test("DELETE turns auto-sync off and is safe to repeat", async () => {
    const { integration, createSecret, enable, disable } = await setUp();
    const secret = await createSecret(githubTokenInput());
    await unwrapAsync(enable(integration.id, secret.id));

    const first = await unwrapAsync(disable(integration.id));
    const second = await unwrapAsync(disable(integration.id));

    expect(first.autoSync).toMatchObject({ state: "off", syncsAs: null });
    expect(second.autoSync).toMatchObject({ state: "off", syncsAs: null });
  });
});

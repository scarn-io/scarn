import { afterEach, describe, expect, mock, test } from "bun:test";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { unwrapAsync } from "tests/utils";
import {
  createSecretsTestUser,
  githubTokenInput,
  jiraApiKeyInput,
} from "tests/secrets/secret/integration/secret-test-support";
import { uninstallJiraIssuesClientMock } from "tests/integrations/github-ingest/integration/jira-issues-client-mock-support";
import { createGitHubEnvGuard } from "tests/projects/project/integration/project-setup-test-support";
import {
  JIRA_BASE_URL,
  setUpAutoSyncTest,
} from "./auto-sync-route-test-support";

const jiraIntegrationInput = {
  kind: "jira",
  externalScope: { baseUrl: JIRA_BASE_URL, projectKeys: ["ACME", "OPS"] },
};

describe("PUT/DELETE /projects/:projectId/integrations/:integrationId/auto-sync — Jira", () => {
  const env = createGitHubEnvGuard();

  afterEach(async () => {
    env.restore();
    await uninstallJiraIssuesClientMock();
    mock.restore();
  });

  const setUp = async (
    jira: { failureStatus?: number; missingProjectKeys?: string[] } = {},
  ) => {
    env.clear();
    const ctx = await setUpAutoSyncTest({ jira });
    const integration = await ctx.createIntegration(jiraIntegrationInput);
    return { ...ctx, integration };
  };

  test("lending a Jira key checks the integration's site and projects, then turns auto-sync on", async () => {
    const { owner, integration, createSecret, enable, jiraCalls } =
      await setUp();
    const secret = await createSecret(
      jiraApiKeyInput({ email: "owner@acme.test", value: "owner-token" }),
    );

    const result = await unwrapAsync(enable(integration.id, secret.id));

    expect(result.autoSync).toMatchObject({
      supported: true,
      state: "on",
      syncsAs: { userId: owner.userId, secretName: secret.name },
      pausedReason: null,
    });
    expect(jiraCalls.length).toBe(3);
    for (const call of jiraCalls) {
      expect(call).toEqual({
        baseUrl: JIRA_BASE_URL,
        email: "owner@acme.test",
        apiToken: "owner-token",
      });
    }
    expect(JSON.stringify(result)).not.toContain("owner-token");
  });

  test("a rejected Jira key is JIRA_API_KEY_REJECTED and nothing is saved", async () => {
    const { integration, createSecret, enable, loadIntegration } = await setUp({
      failureStatus: 401,
    });
    const secret = await createSecret(jiraApiKeyInput());

    const { error } = await enable(integration.id, secret.id);

    expect(error?.status).toBe(400);
    expect(error?.value).toMatchObject({ code: "JIRA_API_KEY_REJECTED" });
    expect((await loadIntegration(integration.id))?.autoSync.state).toBe("off");
  });

  test("a Jira key that can't see one of the projects is rejected naming it", async () => {
    const { integration, createSecret, enable, loadIntegration } = await setUp({
      missingProjectKeys: ["OPS"],
    });
    const secret = await createSecret(jiraApiKeyInput());

    const { error } = await enable(integration.id, secret.id);

    expect(error?.status).toBe(422);
    expect(error?.value).toMatchObject({ code: "JIRA_PROJECT_NOT_FOUND" });
    expect(JSON.stringify(error?.value)).toContain("OPS");
    expect((await loadIntegration(integration.id))?.autoSync.state).toBe("off");
  });

  test("another user's secret 404s without calling Jira", async () => {
    const { integration, createSecret, enable, jiraCalls } = await setUp();
    const stranger = await createSecretsTestUser();
    const strangerSecret = await createSecret(
      jiraApiKeyInput(),
      stranger.authHeaders,
    );

    const { error } = await enable(integration.id, strangerSecret.id);

    expect(error?.status).toBe(404);
    expect(jiraCalls).toHaveLength(0);
  });

  test("a secret of the wrong kind is SECRET_KIND_MISMATCH", async () => {
    const { integration, createSecret, enable, jiraCalls } = await setUp();
    const secret = await createSecret(githubTokenInput());

    const { error } = await enable(integration.id, secret.id);

    expect(error?.status).toBe(400);
    expect(error?.value).toMatchObject({ code: "SECRET_KIND_MISMATCH" });
    expect(jiraCalls).toHaveLength(0);
  });

  test("a teammate taking over replaces the lent key", async () => {
    const { owner, teammate, integration, createSecret, enable } =
      await setUp();
    const ownerSecret = await createSecret(jiraApiKeyInput());
    const teammateSecret = await createSecret(
      jiraApiKeyInput(),
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
    expect(result.autoSync.syncsAs?.userId).not.toBe(owner.userId);
  });

  test("a teammate can't lend the owner's key", async () => {
    const { teammate, integration, createSecret, enable } = await setUp();
    const ownerSecret = await createSecret(jiraApiKeyInput());

    const { error } = await enable(
      integration.id,
      ownerSecret.id,
      teammate.authHeaders,
    );

    expect(error?.status).toBe(404);
  });

  test("DELETE turns auto-sync off, even for someone else's lent key", async () => {
    const { teammate, integration, createSecret, enable, disable } =
      await setUp();
    const secret = await createSecret(jiraApiKeyInput());
    await unwrapAsync(enable(integration.id, secret.id));

    const result = await unwrapAsync(
      disable(integration.id, teammate.authHeaders),
    );

    expect(result.autoSync).toMatchObject({ state: "off", syncsAs: null });
  });

  test("an integration from another project 404s", async () => {
    const { apiClient, owner, createSecret } = await setUp();
    const other = await setUpAutoSyncTest();
    const otherIntegration =
      await other.createIntegration(jiraIntegrationInput);
    const secret = await createSecret(jiraApiKeyInput());
    const myProject = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Another Project",
          description: "Owned by the first user",
          gitUrl: "https://github.com/example/another.git",
        },
        { headers: owner.authHeaders },
      ),
    );

    const projectApi = apiClient.api
      .projects({ projectId: myProject.id })
      .integrations({ integrationId: otherIntegration.id })["auto-sync"];
    const put = await projectApi.put(
      { secretId: parseUuidV7(secret.id) },
      { headers: owner.authHeaders },
    );
    const del = await projectApi.delete(undefined, {
      headers: owner.authHeaders,
    });

    expect(put.error?.status).toBe(404);
    expect(del.error?.status).toBe(404);
  });

  test("a user without access to the project is rejected", async () => {
    const { integration, createSecret, enable, disable } = await setUp();
    const stranger = await createSecretsTestUser();
    const strangerSecret = await createSecret(
      jiraApiKeyInput(),
      stranger.authHeaders,
    );

    const put = await enable(
      integration.id,
      strangerSecret.id,
      stranger.authHeaders,
    );
    const del = await disable(integration.id, stranger.authHeaders);

    expect(put.error?.status).toBe(403);
    expect(del.error?.status).toBe(403);
  });
});

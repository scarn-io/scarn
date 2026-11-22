import { afterEach, describe, expect, mock, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { projectMemberships } from "@/lib/db/schema";
import { unwrapAsync } from "tests/utils";
import {
  githubTokenInput,
  jiraApiKeyInput,
} from "tests/secrets/secret/integration/secret-test-support";
import { uninstallJiraIssuesClientMock } from "tests/integrations/github-ingest/integration/jira-issues-client-mock-support";
import { createGitHubEnvGuard } from "tests/projects/project/integration/project-setup-test-support";
import {
  JIRA_BASE_URL,
  setUpAutoSyncTest,
} from "./auto-sync-route-test-support";

describe("/me/secrets — keys lent to integrations", () => {
  const env = createGitHubEnvGuard();

  afterEach(async () => {
    env.restore();
    await uninstallJiraIssuesClientMock();
    mock.restore();
  });

  const setUp = async () => {
    env.clear();
    const ctx = await setUpAutoSyncTest();
    const jira = await ctx.createIntegration({
      kind: "jira",
      externalScope: { baseUrl: JIRA_BASE_URL, projectKeys: ["ACME"] },
    });
    const github = await ctx.createIntegration({
      kind: "github_token",
      externalScope: { repos: [{ id: 1, fullName: "acme/api" }] },
    });
    const stopUsing = (
      secretId: string,
      integrationId: string,
      headers: { authorization: string },
    ) =>
      ctx.apiClient.api.me
        .secrets({ secretId: parseUuidV7(secretId) })
        .uses({ integrationId: parseUuidV7(integrationId) })
        .delete(undefined, { headers });
    const listSecrets = (headers: { authorization: string }) =>
      unwrapAsync(ctx.apiClient.api.me.secrets.get({ headers }));
    return { ...ctx, jira, github, stopUsing, listSecrets };
  };

  test("usedBy lists only the integrations each key is lent to", async () => {
    const {
      owner,
      teammate,
      project,
      jira,
      github,
      createSecret,
      enable,
      listSecrets,
    } = await setUp();
    const lentJiraKey = await createSecret(jiraApiKeyInput());
    const idleJiraKey = await createSecret(jiraApiKeyInput({ name: "Idle" }));
    const teammateToken = await createSecret(
      githubTokenInput(),
      teammate.authHeaders,
    );
    await unwrapAsync(enable(jira.id, lentJiraKey.id));
    await unwrapAsync(
      enable(github.id, teammateToken.id, teammate.authHeaders),
    );

    const ownerSecrets = await listSecrets(owner.authHeaders);
    expect(ownerSecrets.find((s) => s.id === lentJiraKey.id)?.usedBy).toEqual([
      {
        projectId: project.id,
        projectName: "Auto-sync Project",
        integrationId: jira.id,
        platform: "jira",
      },
    ]);
    expect(ownerSecrets.find((s) => s.id === idleJiraKey.id)?.usedBy).toEqual(
      [],
    );

    const teammateSecrets = await listSecrets(teammate.authHeaders);
    expect(teammateSecrets.map((s) => s.usedBy)).toEqual([
      [
        {
          projectId: project.id,
          projectName: "Auto-sync Project",
          integrationId: github.id,
          platform: "github",
        },
      ],
    ]);
  });

  test("the key's owner can stop using it, even after leaving the project", async () => {
    const {
      teammate,
      project,
      github,
      createSecret,
      enable,
      stopUsing,
      loadIntegration,
    } = await setUp();
    const token = await createSecret(githubTokenInput(), teammate.authHeaders);
    await unwrapAsync(enable(github.id, token.id, teammate.authHeaders));
    await getDb()
      .delete(projectMemberships)
      .where(
        and(
          eq(projectMemberships.projectId, project.id),
          eq(projectMemberships.userId, teammate.userId),
        ),
      );

    const updated = await unwrapAsync(
      stopUsing(token.id, github.id, teammate.authHeaders),
    );

    expect(updated).toMatchObject({ id: token.id, usedBy: [] });
    expect((await loadIntegration(github.id))?.autoSync).toMatchObject({
      state: "off",
      pausedReason: null,
    });
  });

  test("another user can't stop a key they don't own, even with work-items:write", async () => {
    const { teammate, jira, createSecret, enable, stopUsing, loadIntegration } =
      await setUp();
    const key = await createSecret(jiraApiKeyInput());
    await unwrapAsync(enable(jira.id, key.id));

    const { error } = await stopUsing(key.id, jira.id, teammate.authHeaders);

    expect(error?.status).toBe(404);
    expect((await loadIntegration(jira.id))?.autoSync).toMatchObject({
      state: "on",
    });
  });

  test("an integration the key isn't lent to is a 404 and changes nothing", async () => {
    const {
      owner,
      jira,
      github,
      createSecret,
      enable,
      stopUsing,
      loadIntegration,
    } = await setUp();
    const lent = await createSecret(jiraApiKeyInput());
    const other = await createSecret(jiraApiKeyInput({ name: "Other" }));
    await unwrapAsync(enable(jira.id, lent.id));

    const wrongKey = await stopUsing(other.id, jira.id, owner.authHeaders);
    const notLent = await stopUsing(lent.id, github.id, owner.authHeaders);

    expect(wrongKey.error?.status).toBe(404);
    expect(notLent.error?.status).toBe(404);
    expect((await loadIntegration(jira.id))?.autoSync).toMatchObject({
      state: "on",
    });
  });
});

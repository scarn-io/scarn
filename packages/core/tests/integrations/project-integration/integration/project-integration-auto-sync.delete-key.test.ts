import { afterEach, describe, expect, mock, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { projectMemberships, userNotifications } from "@/lib/db/schema";
import { unwrapAsync } from "tests/utils";
import {
  createSecretsTestUser,
  jiraApiKeyInput,
} from "tests/secrets/secret/integration/secret-test-support";
import { uninstallJiraIssuesClientMock } from "tests/integrations/github-ingest/integration/jira-issues-client-mock-support";
import { createGitHubEnvGuard } from "tests/projects/project/integration/project-setup-test-support";
import {
  JIRA_BASE_URL,
  setUpAutoSyncTest,
} from "./auto-sync-route-test-support";

const pausedNotifications = (projectId: string) =>
  getDb()
    .select()
    .from(userNotifications)
    .where(
      and(
        eq(userNotifications.projectId, projectId),
        eq(userNotifications.kind, "integration_auto_sync_paused"),
      ),
    );

describe("DELETE /me/secrets/:secretId — lent keys", () => {
  const env = createGitHubEnvGuard();

  afterEach(async () => {
    env.restore();
    await uninstallJiraIssuesClientMock();
    mock.restore();
  });

  const setUp = async () => {
    env.clear();
    const ctx = await setUpAutoSyncTest();
    const integration = await ctx.createIntegration({
      kind: "jira",
      externalScope: { baseUrl: JIRA_BASE_URL, projectKeys: ["ACME"] },
    });
    const secret = await ctx.createSecret(jiraApiKeyInput());
    await unwrapAsync(ctx.enable(integration.id, secret.id));
    return { ...ctx, integration, secret };
  };

  test("pauses each integration the key was lent to with key_removed, then deletes the key and notifies writers", async () => {
    const { apiClient, owner, teammate, project, integration, secret } =
      await setUp();
    const reviewer = await createSecretsTestUser();
    await getDb()
      .insert(projectMemberships)
      .values({
        projectId: project.id,
        userId: reviewer.userId,
        role: "read",
      });

    await unwrapAsync(
      apiClient.api.me
        .secrets({ secretId: parseUuidV7(secret.id) })
        .delete(undefined, { headers: owner.authHeaders }),
    );

    const list = await unwrapAsync(
      apiClient.api
        .projects({ projectId: project.id })
        .integrations.get({ headers: owner.authHeaders }),
    );
    expect(
      list.find((entry) => entry.id === integration.id)?.autoSync,
    ).toMatchObject({ state: "paused", pausedReason: "key_removed" });
    const ownerSecrets = await unwrapAsync(
      apiClient.api.me.secrets.get({ headers: owner.authHeaders }),
    );
    expect(ownerSecrets.map((entry) => entry.id)).not.toContain(secret.id);

    const notifications = await pausedNotifications(project.id);
    expect(notifications.map((n) => n.recipientUserId).sort()).toEqual(
      [owner.userId, teammate.userId].sort(),
    );
    for (const notification of notifications) {
      expect(notification).toMatchObject({
        audience: "specific_users",
        source: "system",
        workItemId: null,
        title: "Auto-sync for ACME paused",
        payloadJson: {
          integrationId: integration.id,
          reason: "key_removed",
          detail: null,
        },
      });
      expect(notification.body).toEndWith("'s key was deleted.");
      expect(notification.body).not.toContain("@");
    }
  });

  test("another user's ID is a 404 and pauses nothing", async () => {
    const {
      apiClient,
      teammate,
      project,
      integration,
      secret,
      loadIntegration,
    } = await setUp();

    const { error } = await apiClient.api.me
      .secrets({ secretId: parseUuidV7(secret.id) })
      .delete(undefined, { headers: teammate.authHeaders });

    expect(error?.status).toBe(404);
    expect((await loadIntegration(integration.id))?.autoSync).toMatchObject({
      state: "on",
      pausedReason: null,
    });
    expect(await pausedNotifications(project.id)).toEqual([]);
  });
});

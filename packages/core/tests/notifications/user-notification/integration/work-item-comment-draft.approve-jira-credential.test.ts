import { afterEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { projectMemberships, secrets } from "@/lib/db/schema";
import { createUuidV7, parseUuidV7 } from "@/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import { fixedTimeProvider, unwrapAsync } from "tests/utils";
import {
  createSecretsTestUser,
  daysFromNow,
  jiraApiKeyInput,
  SECRETS_TEST_NOW,
} from "tests/secrets/secret/integration/secret-test-support";
import {
  installJiraCommentClientMock,
  uninstallJiraCommentClientMock,
} from "./comment-draft-jira-fetch-support";
import {
  emitNotificationSignal,
  findPendingDraftByBody,
} from "./emit-notification-signal-support";

const JIRA_BASE_URL = "https://acme.atlassian.net";

/**
 * Approving a Jira comment draft with a per-request credential: a saved
 * secret or a pasted email + API token. The Jira comment client is replaced
 * via `mock.module` (`comment-draft-jira-fetch-support.ts`), so
 * `createApp`/`createAppContext` are imported after the mock is installed
 * and every test runs serially.
 */
describe("approve comment draft — Jira credentials", () => {
  afterEach(async () => {
    await uninstallJiraCommentClientMock();
    mock.restore();
  });

  const setUp = async () => {
    const { calls } = await installJiraCommentClientMock();
    const { createApp } = await import("@scarn/api/app");
    const { createAppContext } = await import("@/lib/di");
    const apiClient = createScarnTreaty(
      createApp(
        createAppContext({ timeProvider: fixedTimeProvider(SECRETS_TEST_NOW) }),
      ),
    );

    const owner = await createSecretsTestUser();
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Jira Credential Approve Project",
          description: "Project for Jira credential approve tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: owner.authHeaders },
      ),
    );
    await unwrapAsync(
      apiClient.api.projects({ projectId: project.id }).integrations.post(
        {
          kind: "jira",
          externalScope: { baseUrl: JIRA_BASE_URL, projectKeys: ["PROJ"] },
        },
        { headers: owner.authHeaders },
      ),
    );
    const workItem = await unwrapAsync(
      apiClient.api["work-items"].post(
        {
          projectId: project.id,
          platform: "jira",
          platformId: null,
          platformKey: "PROJ-1",
          url: null,
          title: "Jira issue",
          description: "Repro steps",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          fields: null,
        },
        { headers: owner.authHeaders },
      ),
    );

    const seedDraft = async () => {
      const body = `Draft ${crypto.randomUUID()}`;
      await emitNotificationSignal({
        apiClient,
        authHeaders: owner.authHeaders,
        projectId: parseUuidV7(project.id),
        workItemId: parseUuidV7(workItem.id),
        items: [
          {
            kind: "status_update",
            body,
            suggestedChannels: ["work_item_platform_comment"],
          },
        ],
      });
      const draft = await findPendingDraftByBody(
        apiClient,
        owner.authHeaders,
        parseUuidV7(workItem.id),
        body,
      );
      return draft.notification.id;
    };

    /** Untyped body so invalid shapes can be sent to check the 422s. */
    const approve = (
      notificationId: string,
      body: Record<string, unknown>,
      headers: { authorization: string } = owner.authHeaders,
    ) =>
      apiClient.api["work-item-comment-drafts"]({
        notificationId,
      }).approve.post(body as never, { headers });

    const loadSecretRow = async (secretId: string) => {
      const [row] = await getDb()
        .select()
        .from(secrets)
        .where(eq(secrets.id, parseUuidV7(secretId)));
      return row;
    };

    return {
      apiClient,
      calls,
      owner,
      project,
      seedDraft,
      approve,
      loadSecretRow,
    };
  };

  test("a saved secret posts with its own email and token, and marks it used", async () => {
    const { apiClient, calls, owner, seedDraft, approve, loadSecretRow } =
      await setUp();
    const token = `saved-token-${crypto.randomUUID()}`;
    const secret = await unwrapAsync(
      apiClient.api.me.secrets.post(
        jiraApiKeyInput({ email: "saved@acme.test", value: token }),
        { headers: owner.authHeaders },
      ),
    );
    const notificationId = await seedDraft();

    await unwrapAsync(
      approve(notificationId, {
        body: "Saved key comment",
        credential: { secretId: secret.id },
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      baseUrl: JIRA_BASE_URL,
      email: "saved@acme.test",
      apiToken: token,
      issueKey: "PROJ-1",
    });
    expect((await loadSecretRow(secret.id))?.lastUsedAt?.toISOString()).toBe(
      SECRETS_TEST_NOW.toISOString(),
    );
  });

  test("two users approving in the same project each post with their own email", async () => {
    const { apiClient, calls, owner, project, seedDraft, approve } =
      await setUp();
    const teammate = await createSecretsTestUser();
    await getDb()
      .insert(projectMemberships)
      .values({
        projectId: project.id,
        userId: teammate.userId,
        role: "admin",
      });
    const ownerSecret = await unwrapAsync(
      apiClient.api.me.secrets.post(
        jiraApiKeyInput({ email: "owner@acme.test", value: "owner-token" }),
        { headers: owner.authHeaders },
      ),
    );
    const teammateSecret = await unwrapAsync(
      apiClient.api.me.secrets.post(
        jiraApiKeyInput({
          email: "teammate@acme.test",
          value: "teammate-token",
        }),
        { headers: teammate.authHeaders },
      ),
    );
    const ownerDraft = await seedDraft();
    const teammateDraft = await seedDraft();

    await unwrapAsync(
      approve(ownerDraft, {
        body: "Owner comment",
        credential: { secretId: ownerSecret.id },
      }),
    );
    await unwrapAsync(
      approve(
        teammateDraft,
        {
          body: "Teammate comment",
          credential: { secretId: teammateSecret.id },
        },
        teammate.authHeaders,
      ),
    );

    expect(calls.map((call) => [call.email, call.apiToken])).toEqual([
      ["owner@acme.test", "owner-token"],
      ["teammate@acme.test", "teammate-token"],
    ]);
  });

  test("422s for both secretId and apiKey, or an apiKey without an email", async () => {
    const { calls, seedDraft, approve } = await setUp();
    const notificationId = await seedDraft();

    const both = await approve(notificationId, {
      body: "Comment",
      credential: {
        secretId: createUuidV7(),
        email: "x@acme.test",
        apiKey: "token",
      },
    });
    const noEmail = await approve(notificationId, {
      body: "Comment",
      credential: { apiKey: "token" },
    });

    expect(both.error?.status).toBe(422);
    expect(noEmail.error?.status).toBe(422);
    expect(calls).toHaveLength(0);
  });

  test("another user's secretId 404s without calling Jira", async () => {
    const { apiClient, calls, seedDraft, approve } = await setUp();
    const stranger = await createSecretsTestUser();
    const strangerSecret = await unwrapAsync(
      apiClient.api.me.secrets.post(jiraApiKeyInput(), {
        headers: stranger.authHeaders,
      }),
    );
    const notificationId = await seedDraft();

    const { error } = await approve(notificationId, {
      body: "Comment",
      credential: { secretId: strangerSecret.id },
    });

    expect(error?.status).toBe(404);
    expect(error?.value).toMatchObject({ code: "SECRET_NOT_FOUND" });
    expect(calls).toHaveLength(0);
  });

  test("an expired secret fails with SECRET_EXPIRED without calling Jira", async () => {
    const { apiClient, calls, owner, seedDraft, approve, loadSecretRow } =
      await setUp();
    const secret = await unwrapAsync(
      apiClient.api.me.secrets.post(
        jiraApiKeyInput({ expiresAt: daysFromNow(1) }),
        { headers: owner.authHeaders },
      ),
    );
    await getDb()
      .update(secrets)
      .set({ expiresAt: new Date(daysFromNow(-1)) })
      .where(eq(secrets.id, parseUuidV7(secret.id)));
    const notificationId = await seedDraft();

    const { error } = await approve(notificationId, {
      body: "Comment",
      credential: { secretId: secret.id },
    });

    expect(error?.status).toBe(400);
    expect(error?.value).toMatchObject({ code: "SECRET_EXPIRED" });
    expect(calls).toHaveLength(0);
    expect((await loadSecretRow(secret.id))?.lastUsedAt).toBeNull();
  });
});

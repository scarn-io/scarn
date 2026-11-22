import { afterEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createScarnTreaty } from "tests/treaty";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { jiraApiKeyInput } from "tests/secrets/secret/integration/secret-test-support";
import { getDb } from "@/lib/db";
import { secrets } from "@/lib/db/schema";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";
import {
  installJiraCommentClientMock,
  JIRA_COMMENT_POST_FAILURE_MESSAGE,
  MOCKED_JIRA_COMMENT_ID,
  uninstallJiraCommentClientMock,
} from "./comment-draft-jira-fetch-support";
import {
  emitNotificationSignal,
  findPendingDraftByBody,
} from "./emit-notification-signal-support";

/** A fake API token used only as this test's fixture — asserted to never
 * appear in the resulting failure message (Decision 8's message-hygiene
 * guarantee). */
const FAKE_JIRA_API_KEY = "atlassian-fake-api-key-do-not-leak-me";

const PASTED_REJECTED_MESSAGE = "Jira rejected that email and API token.";

/**
 * Exercises Decision 8/Decision 7's Jira analogue: a Jira 401 on the comment
 * post becomes `JIRA_API_KEY_REJECTED`, upserts the delivery row to `failed`
 * without leaking the caller's token or Jira's own error text into the
 * stored/thrown message, creates no `work_item_comments` row, but stays
 * retryable. Approve is then retried on the *same* notification, this time
 * with the mock configured to succeed, proving the delivery row is upserted
 * rather than duplicated — mirroring `work-item-comment-draft.approve
 * -failure.test.ts`'s GitHub structure.
 *
 * See `work-item-comment-draft.approve-jira.test.ts` for why `mock.module`
 * (rather than a faked `globalThis.fetch`) is used here, and why this file
 * uses plain serial `test`.
 */
describe("approve comment draft — Jira post failure", () => {
  afterEach(async () => {
    await uninstallJiraCommentClientMock();
    mock.restore();
  });

  const setUp = async () => {
    await installJiraCommentClientMock({
      shouldFail: true,
      failureStatus: 401,
    });

    const { createApp } = await import("@scarn/api/app");
    const { createAppContext } = await import("@/lib/di");
    const { DrizzleUserNotificationRepo } =
      await import("@/notifications/user-notification/infra/drizzle-user-notification-repo");
    const { DrizzleNotificationDeliveryRepo } =
      await import("@/notifications/notification-delivery/infra/drizzle-notification-delivery-repo");

    const NOW = new Date("2026-04-22T12:00:00.000Z");
    const userNotificationRepo = new DrizzleUserNotificationRepo();
    const notificationDeliveryRepo = new DrizzleNotificationDeliveryRepo();
    const app = createApp(
      createAppContext({
        timeProvider: fixedTimeProvider(NOW),
        userNotificationRepo,
        notificationDeliveryRepo,
      }),
    );
    const apiClient = createScarnTreaty(app);

    const owner = await createTestUserAndSession({
      email: `comment-draft-approve-jira-failure-${crypto.randomUUID()}@example.com`,
    });
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Comment Draft Approve Jira Failure Project",
          description: "Project for Jira comment draft approve-failure tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );

    const baseUrl = "https://acme.atlassian.net";
    await unwrapAsync(
      apiClient.api.projects({ projectId: project.id }).integrations.post(
        {
          kind: "jira",
          externalScope: {
            baseUrl,
            projectKeys: ["PROJ"],
          },
        },
        { headers: { ...owner.authHeaders } },
      ),
    );

    const workItem = await unwrapAsync(
      apiClient.api["work-items"].post(
        {
          projectId: project.id,
          platform: "jira",
          platformId: null,
          platformKey: "PROJ-7",
          url: null,
          title: "Another Jira issue",
          description: "Repro steps",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          fields: null,
        },
        { headers: { ...owner.authHeaders } },
      ),
    );

    const draftBody = `Draft: first attempt ${crypto.randomUUID()}.`;

    await emitNotificationSignal({
      apiClient,
      authHeaders: owner.authHeaders,
      projectId: parseUuidV7(project.id),
      workItemId: parseUuidV7(workItem.id),
      items: [
        {
          kind: "status_update",
          body: draftBody,
          suggestedChannels: ["work_item_platform_comment"],
        },
      ],
    });

    const seededDraft = await findPendingDraftByBody(
      apiClient,
      owner.authHeaders,
      parseUuidV7(workItem.id),
      draftBody,
    );
    const notificationId = seededDraft.notification.id;

    const findCommentDelivery = async () => {
      const deliveries = await notificationDeliveryRepo.listByNotificationId(
        parseUuidV7(notificationId),
      );
      return {
        deliveries,
        commentDelivery: deliveries.find(
          (d) => d.channel === "work_item_platform_comment",
        ),
      };
    };

    return {
      apiClient,
      owner,
      workItem,
      notificationId,
      userNotificationRepo,
      findCommentDelivery,
    };
  };

  test("records a failed delivery whose message never contains the API token, creates no comment row, and can be retried successfully", async () => {
    const {
      apiClient,
      owner,
      workItem,
      notificationId,
      userNotificationRepo,
      findCommentDelivery,
    } = await setUp();

    const { data: failedData, error: failedError } = await apiClient.api[
      "work-item-comment-drafts"
    ]({ notificationId }).approve.post(
      {
        body: "First attempt",
        credential: {
          email: "approver@acme.com",
          apiKey: FAKE_JIRA_API_KEY,
        },
      },
      { headers: { ...owner.authHeaders } },
    );

    expect(failedData).toBeNull();
    expect(failedError?.status).toBe(400);
    expect(failedError?.value).toMatchObject({
      code: "JIRA_API_KEY_REJECTED",
      detail: PASTED_REJECTED_MESSAGE,
    });
    const failedJson = JSON.stringify(failedError?.value);
    expect(failedJson).not.toContain(FAKE_JIRA_API_KEY);
    expect(failedJson).not.toContain(JIRA_COMMENT_POST_FAILURE_MESSAGE);

    const { deliveries: deliveriesAfterFailure, commentDelivery: failed } =
      await findCommentDelivery();
    expect(failed?.status).toBe("failed");
    expect(failed?.suppressionReason).toBe(PASTED_REJECTED_MESSAGE);
    expect(failed?.suppressionReason).not.toContain(FAKE_JIRA_API_KEY);
    expect(failed?.externalId).toBeNull();
    expect(failed?.sentAt).toBeNull();
    expect(
      deliveriesAfterFailure.find((d) => d.channel === "in_app")?.status,
    ).toBe("sent");

    const notificationAfterFailure = await userNotificationRepo.load(
      parseUuidV7(notificationId),
    );
    expect(notificationAfterFailure?.status).toBe("partially_delivered");

    const commentsAfterFailure = await unwrapAsync(
      apiClient.api["work-item-comments"].get({
        query: { workItemId: parseWorkItemId(workItem.id) },
        headers: { ...owner.authHeaders },
      }),
    );
    expect(commentsAfterFailure).toHaveLength(0);

    await installJiraCommentClientMock({ shouldFail: false });

    const comment = await unwrapAsync(
      apiClient.api["work-item-comment-drafts"]({
        notificationId,
      }).approve.post(
        {
          body: "Retry attempt",
          credential: {
            email: "approver@acme.com",
            apiKey: "corrected-jira-api-key",
          },
        },
        { headers: { ...owner.authHeaders } },
      ),
    );

    expect(comment).toMatchObject({
      authorKind: "agent",
      body: "Retry attempt",
      externalCommentId: MOCKED_JIRA_COMMENT_ID,
    });

    const { deliveries: deliveriesAfterRetry, commentDelivery: retried } =
      await findCommentDelivery();
    expect(deliveriesAfterRetry).toHaveLength(2);
    expect(retried?.status).toBe("sent");
    expect(retried?.externalId).toBe(MOCKED_JIRA_COMMENT_ID);

    const notificationAfterRetry = await userNotificationRepo.load(
      parseUuidV7(notificationId),
    );
    expect(notificationAfterRetry?.status).toBe("delivered");
  });

  test("a Jira 401 with a saved secret names the key, leaks no token, and leaves lastUsedAt unset", async () => {
    const { apiClient, owner, notificationId, findCommentDelivery } =
      await setUp();
    const token = `rejected-token-${crypto.randomUUID()}`;
    const secret = await unwrapAsync(
      apiClient.api.me.secrets.post(
        jiraApiKeyInput({
          name: "Work Jira",
          email: "rejected@acme.test",
          value: token,
        }),
        { headers: owner.authHeaders },
      ),
    );
    const expectedMessage =
      'Jira rejected the saved key "Work Jira". Check its email and token, or replace it.';

    const { error } = await apiClient.api["work-item-comment-drafts"]({
      notificationId,
    }).approve.post(
      { body: "Saved key attempt", credential: { secretId: secret.id } },
      { headers: { ...owner.authHeaders } },
    );

    expect(error?.status).toBe(400);
    expect(error?.value).toMatchObject({
      code: "JIRA_API_KEY_REJECTED",
      detail: expectedMessage,
    });
    const errorJson = JSON.stringify(error?.value);
    expect(errorJson).not.toContain(token);
    expect(errorJson).not.toContain("rejected@acme.test");

    const { commentDelivery } = await findCommentDelivery();
    expect(commentDelivery?.status).toBe("failed");
    expect(commentDelivery?.suppressionReason).toBe(expectedMessage);

    const [row] = await getDb()
      .select()
      .from(secrets)
      .where(eq(secrets.id, parseUuidV7(secret.id)));
    expect(row?.lastUsedAt).toBeNull();
  });
});

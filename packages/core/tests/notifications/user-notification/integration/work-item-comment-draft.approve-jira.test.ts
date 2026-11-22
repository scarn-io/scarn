import { afterEach, describe, expect, mock, test } from "bun:test";
import { fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createScarnTreaty } from "tests/treaty";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import {
  installJiraCommentClientMock,
  MOCKED_JIRA_COMMENT_ID,
  uninstallJiraCommentClientMock,
} from "./comment-draft-jira-fetch-support";
import {
  emitNotificationSignal,
  findPendingDraftByBody,
} from "./emit-notification-signal-support";

/**
 * Exercises the Jira half of Phase 1/2's `approveCommentDraft`: an approve
 * request with no `credential` 400s with `JIRA_API_KEY_REQUIRED` (Decision 4),
 * and a request with one posts the (possibly human-edited) draft body to
 * Jira, records a `sent` `notification_deliveries` row, and promotes an
 * agent-authored `work_item_comments` row — the same tail already exercised
 * by `work-item-comment-draft.approve.test.ts` for GitHub, now reached via
 * the Jira branch.
 *
 * `postJiraIssueComment` is substituted via `mock.module`
 * (`comment-draft-jira-fetch-support.ts`) rather than a faked
 * `globalThis.fetch`. `createApp`/
 * `createAppContext` are imported dynamically, *after* the mock is
 * registered, so `approve-comment-draft.ts`'s import of the real
 * `jira-comment-client` module resolves to the mock — mirroring the
 * dynamic-import ordering in `ingest-jira-issues.test.ts`. `mock.module`
 * mutates global module resolution, so this file uses plain serial `test`
 * rather than `concurrentTest`, exactly like the GitHub approve tests do
 * for their own (different) shared mutable state.
 */
describe("approve comment draft — Jira happy path", () => {
  afterEach(async () => {
    await uninstallJiraCommentClientMock();
    mock.restore();
  });

  test("400s without a Jira credential, then posts the edited body to Jira, records a sent delivery, and promotes an agent-authored comment", async () => {
    await installJiraCommentClientMock();

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
      email: `comment-draft-approve-jira-${crypto.randomUUID()}@example.com`,
    });
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Comment Draft Approve Jira Project",
          description: "Project for Jira comment draft approve tests",
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
          platformKey: "PROJ-123",
          url: null,
          title: "Some Jira issue",
          description: "Repro steps",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          fields: null,
        },
        { headers: { ...owner.authHeaders } },
      ),
    );

    const draftBody = "Draft: thanks for reporting this.";

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

    const editedBody =
      "Thanks for the detailed repro — we're investigating now.";

    const { data: missingKeyData, error: missingKeyError } =
      await apiClient.api["work-item-comment-drafts"]({
        notificationId,
      }).approve.post(
        { body: editedBody },
        { headers: { ...owner.authHeaders } },
      );

    expect(missingKeyData).toBeNull();
    expect(missingKeyError?.status).toBe(400);
    expect(missingKeyError?.value).toMatchObject({
      code: "JIRA_API_KEY_REQUIRED",
    });

    const comment = await unwrapAsync(
      apiClient.api["work-item-comment-drafts"]({
        notificationId,
      }).approve.post(
        {
          body: editedBody,
          credential: {
            email: "approver@acme.com",
            apiKey: "test-jira-api-key",
          },
        },
        { headers: { ...owner.authHeaders } },
      ),
    );

    expect(comment).toMatchObject({
      projectId: project.id,
      workItemId: workItem.id,
      authorUserId: null,
      authorKind: "agent",
      agentSessionId: null,
      sourceNotificationId: notificationId,
      body: editedBody,
      externalCommentId: MOCKED_JIRA_COMMENT_ID,
      externalCommentUrl: `${baseUrl}/browse/PROJ-123?focusedCommentId=${MOCKED_JIRA_COMMENT_ID}`,
      isPinned: false,
    });

    const deliveries = await notificationDeliveryRepo.listByNotificationId(
      parseUuidV7(notificationId),
    );
    const delivery = deliveries.find(
      (d) => d.channel === "work_item_platform_comment",
    );
    expect(delivery).toBeDefined();
    expect(delivery?.status).toBe("sent");
    expect(delivery?.externalId).toBe(MOCKED_JIRA_COMMENT_ID);
    expect(delivery?.externalUrl).toBe(
      `${baseUrl}/browse/PROJ-123?focusedCommentId=${MOCKED_JIRA_COMMENT_ID}`,
    );
    expect(delivery?.sentAt).not.toBeNull();

    const notification = await userNotificationRepo.load(
      parseUuidV7(notificationId),
    );
    expect(notification?.status).toBe("delivered");
  });
});

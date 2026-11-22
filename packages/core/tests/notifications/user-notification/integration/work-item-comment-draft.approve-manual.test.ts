import { describe, expect, test } from "bun:test";
import { createApp } from "@scarn/api/app";
import { createAppContext } from "@/lib/di";
import { fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createScarnTreaty } from "tests/treaty";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { DrizzleUserNotificationRepo } from "@/notifications/user-notification/infra/drizzle-user-notification-repo";
import { DrizzleNotificationDeliveryRepo } from "@/notifications/notification-delivery/infra/drizzle-notification-delivery-repo";
import {
  emitNotificationSignal,
  findPendingDraftByBody,
} from "./emit-notification-signal-support";

/**
 * A work item that is neither GitHub nor Jira (here a hand-created
 * `scarn` item) has no external thread to post to, so approving its draft
 * skips the platform post: the edited body becomes an agent-authored
 * `work_item_comments` row with no external id/url, and the delivery is
 * marked `sent`.
 */
describe("approve comment draft — work item with no external platform", () => {
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

  test("saves the edited body as an agent-authored comment and marks the delivery sent", async () => {
    const owner = await createTestUserAndSession({
      email: `comment-draft-approve-manual-${crypto.randomUUID()}@example.com`,
    });
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Comment Draft Approve Manual Project",
          description: "Project for manual work item comment draft tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );

    const workItem = await unwrapAsync(
      apiClient.api["work-items"].post(
        {
          projectId: project.id,
          platform: "scarn",
          platformId: null,
          platformKey: `manual-${crypto.randomUUID()}`,
          url: null,
          title: "A hand-entered bug",
          description: "It breaks sometimes",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          fields: null,
        },
        { headers: { ...owner.authHeaders } },
      ),
    );

    const draftBody = "Draft: could you share the steps to reproduce?";

    await emitNotificationSignal({
      apiClient,
      authHeaders: owner.authHeaders,
      projectId: parseUuidV7(project.id),
      workItemId: parseUuidV7(workItem.id),
      items: [
        {
          kind: "feedback_request",
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
      "Could you share the exact steps and the browser you used?";

    const comment = await unwrapAsync(
      apiClient.api["work-item-comment-drafts"]({
        notificationId,
      }).approve.post(
        { body: editedBody },
        { headers: { ...owner.authHeaders } },
      ),
    );

    expect(comment).toMatchObject({
      projectId: project.id,
      workItemId: workItem.id,
      authorUserId: null,
      authorKind: "agent",
      sourceNotificationId: notificationId,
      body: editedBody,
      externalCommentId: null,
      externalCommentUrl: null,
      isPinned: false,
    });

    const deliveries = await notificationDeliveryRepo.listByNotificationId(
      parseUuidV7(notificationId),
    );
    const delivery = deliveries.find(
      (d) => d.channel === "work_item_platform_comment",
    );
    expect(delivery?.status).toBe("sent");
    expect(delivery?.externalId).toBeNull();
    expect(delivery?.externalUrl).toBeNull();
    expect(delivery?.sentAt).not.toBeNull();

    const notification = await userNotificationRepo.load(
      parseUuidV7(notificationId),
    );
    expect(notification?.status).toBe("delivered");
  });
});

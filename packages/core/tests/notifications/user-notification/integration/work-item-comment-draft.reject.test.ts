import { describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { createAppContext } from "@/lib/di";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createScarnTreaty } from "tests/treaty";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";
import { DrizzleUserNotificationRepo } from "@/notifications/user-notification/infra/drizzle-user-notification-repo";
import { DrizzleNotificationDeliveryRepo } from "@/notifications/notification-delivery/infra/drizzle-notification-delivery-repo";
import {
  emitNotificationSignal,
  findPendingDraftByBody,
} from "./emit-notification-signal-support";

/**
 * Exercises Decision 5/7: rejecting a `work_item_platform_comment` draft
 * marks *that delivery row* `"suppressed"` — not the whole notification —
 * so an already-`"sent"` `in_app` delivery on the same notification (every
 * notification gets one by default, Decision 3/4) is never clobbered. The
 * notification's own `status` is then recomputed from all of its
 * deliveries via `UserNotificationEntity.deriveStatus()`. Never reassigns
 * `globalThis.fetch` (reject never calls GitHub), so this file uses
 * `concurrentTest` as normal.
 */
describe("reject comment draft", () => {
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

  const setupProjectAndWorkItem = async (emailPrefix: string) => {
    const owner = await createTestUserAndSession({
      email: `${emailPrefix}-${crypto.randomUUID()}@example.com`,
    });
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Comment Draft Reject Project",
          description: "Project for comment draft reject tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    const workItem = await unwrapAsync(
      apiClient.api["work-items"].post(
        {
          projectId: project.id,
          platform: "github",
          platformId: null,
          platformKey: `acme-org/rejects#${crypto.randomUUID()}`,
          url: null,
          title: "A GitHub issue",
          description: "Repro steps",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          fields: { repository: "acme-org/rejects", number: 1 },
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    return { owner, project, workItem };
  };

  const seedDraft = async (
    owner: Awaited<ReturnType<typeof createTestUserAndSession>>,
    project: { id: string },
    workItem: { id: string },
    body: string,
  ) => {
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

  // Covers Decision 5's "reject on a notification that also has a
  // successful `in_app` delivery" case: the fixture seeded via the real
  // signal path always gets an `in_app` delivery alongside the
  // `work_item_platform_comment` one (Decision 3/4's default-candidate
  // behavior), so this single test both exercises the ordinary reject path
  // and proves the overall status derivation is no longer clobbered.
  concurrentTest(
    "suppresses only the platform-comment delivery, leaves the in_app delivery and its own status untouched, derives the notification's overall status from both, and creates no comment row",
    async () => {
      const { owner, project, workItem } =
        await setupProjectAndWorkItem("comment-draft-reject");
      const notificationId = await seedDraft(
        owner,
        project,
        workItem,
        "Draft: this will be rejected.",
      );

      // Before reject: two delivery rows already exist (eager creation,
      // Decision 8) — `in_app` already `"sent"`, `work_item_platform_comment`
      // still `"pending"`.
      const deliveriesBeforeReject =
        await notificationDeliveryRepo.listByNotificationId(
          parseUuidV7(notificationId),
        );
      expect(deliveriesBeforeReject).toHaveLength(2);
      expect(
        deliveriesBeforeReject.find((d) => d.channel === "in_app")?.status,
      ).toBe("sent");
      expect(
        deliveriesBeforeReject.find(
          (d) => d.channel === "work_item_platform_comment",
        )?.status,
      ).toBe("pending");

      const rejected = await unwrapAsync(
        apiClient.api["work-item-comment-drafts"]({ notificationId })
          .reject.post(undefined, { headers: { ...owner.authHeaders } }),
      );

      // Decision 5: the notification's overall status is *derived*, not
      // hardcoded to `"suppressed"`. With `in_app` `"sent"` and
      // `work_item_platform_comment` now `"suppressed"`,
      // `deriveStatus(["sent", "suppressed"])` = `"partially_delivered"`.
      expect(rejected.status).toBe("partially_delivered");
      expect(rejected.id).toBe(notificationId);

      const deliveries = await notificationDeliveryRepo.listByNotificationId(
        parseUuidV7(notificationId),
      );
      expect(deliveries).toHaveLength(2);
      const platformCommentDelivery = deliveries.find(
        (d) => d.channel === "work_item_platform_comment",
      );
      expect(platformCommentDelivery?.status).toBe("suppressed");
      expect(platformCommentDelivery?.suppressionReason).toBeNull();
      // The unrelated `in_app` delivery is untouched by reject.
      expect(deliveries.find((d) => d.channel === "in_app")?.status).toBe(
        "sent",
      );

      const comments = await unwrapAsync(
        apiClient.api["work-item-comments"].get({
          query: { workItemId: parseWorkItemId(workItem.id) },
          headers: { ...owner.authHeaders },
        }),
      );
      expect(comments).toHaveLength(0);
    },
  );

  concurrentTest(
    "rejecting an already-actioned draft returns a 409 conflict",
    async () => {
      const { owner, project, workItem } =
        await setupProjectAndWorkItem("comment-draft-reject-twice");
      const notificationId = await seedDraft(
        owner,
        project,
        workItem,
        "Draft: rejected twice.",
      );

      await unwrapAsync(
        apiClient.api["work-item-comment-drafts"]({ notificationId })
          .reject.post(undefined, { headers: { ...owner.authHeaders } }),
      );

      const { data, error } = await apiClient.api[
        "work-item-comment-drafts"
      ]({ notificationId }).reject.post(undefined, {
        headers: { ...owner.authHeaders },
      });

      expect(data).toBeNull();
      expect(error?.status).toBe(409);
    },
  );
});

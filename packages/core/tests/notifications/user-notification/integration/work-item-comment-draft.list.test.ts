import { describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { createAppContext } from "@/lib/di";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createScarnTreaty } from "tests/treaty";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { DrizzleUserNotificationRepo } from "@/notifications/user-notification/infra/drizzle-user-notification-repo";
import {
  emitNotificationSignal,
  findDrawerNotificationByBody,
  findPendingDraftByBody,
} from "./emit-notification-signal-support";

/**
 * Exercises `list-pending-comment-drafts.ts` (backed by
 * `listPendingWorkItemPlatformCommentDrafts`, Decision 12) together with the
 * general notifications drawer (`list-user-notifications.ts`). Per Decision
 * 4, the drawer no longer excludes anything by kind — a notification that
 * suggested `work_item_platform_comment` still shows up there via its own
 * `in_app` delivery, at the same time as it's independently listed as a
 * pending draft via its `work_item_platform_comment` delivery (Decision 3).
 * This inverts the shipped feature's old "comment_draft is hidden from the
 * drawer" assertion.
 *
 * Never reassigns `globalThis.fetch` (only the "excluded, already-actioned"
 * fixture calls `reject`, which never touches GitHub), so this file uses
 * `concurrentTest` as normal.
 */
describe("list pending comment drafts", () => {
  const NOW = new Date("2026-04-22T12:00:00.000Z");
  const userNotificationRepo = new DrizzleUserNotificationRepo();
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(NOW),
      userNotificationRepo,
    }),
  );
  const apiClient = createScarnTreaty(app);

  const setup = async (emailPrefix: string) => {
    const owner = await createTestUserAndSession({
      email: `${emailPrefix}-${crypto.randomUUID()}@example.com`,
    });
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Comment Draft List Project",
          description: "Project for comment draft list tests",
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
          platformKey: `acme-org/list-target#${crypto.randomUUID()}`,
          url: null,
          title: "The target work item",
          description: "Repro steps",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          fields: { repository: "acme-org/list-target", number: 1 },
        },
        { headers: { ...owner.authHeaders } },
      ),
    );

    return { owner, project, workItem };
  };

  concurrentTest(
    "returns only actionable work_item_platform_comment drafts for the work item, and includes them in the general notifications drawer via their own in_app delivery",
    async () => {
      const { owner, project, workItem } = await setup("comment-draft-list");

      const otherWorkItem = await unwrapAsync(
        apiClient.api["work-items"].post(
          {
            projectId: project.id,
            platform: "github",
            platformId: null,
            platformKey: `acme-org/list-other#${crypto.randomUUID()}`,
            url: null,
            title: "A different work item",
            description: "Repro steps",
            sourceCreatedAt: null,
            sourceUpdatedAt: null,
            fields: { repository: "acme-org/list-other", number: 2 },
          },
          { headers: { ...owner.authHeaders } },
        ),
      );

      const pendingDraftBody = "Pending draft awaiting review";
      const alreadyRejectedBody = "Already-rejected draft";
      const ordinaryInAppBody = "Need more info (in_app only)";
      const otherWorkItemDraftBody = "Pending draft on a different work item";

      // The one draft expected back from `/work-item-comment-drafts`. Any
      // ordinary kind + `suggestedChannels: ["work_item_platform_comment"]`
      // (Decisions 1/3) — the dispatcher independently also creates this
      // notification's default `in_app` delivery, which is the basis for
      // the Decision 3/4 drawer-visibility assertions below.
      await emitNotificationSignal({
        apiClient,
        authHeaders: owner.authHeaders,
        projectId: parseUuidV7(project.id),
        workItemId: parseUuidV7(workItem.id),
        items: [
          {
            kind: "status_update",
            body: pendingDraftBody,
            suggestedChannels: ["work_item_platform_comment"],
          },
        ],
      });

      // Excluded from `/work-item-comment-drafts`: its
      // `work_item_platform_comment` delivery is already terminal
      // (`"suppressed"`, per Decision 7) because it was rejected — the
      // most production-faithful way to reach that terminal state, rather
      // than hand-constructing a delivery row.
      await emitNotificationSignal({
        apiClient,
        authHeaders: owner.authHeaders,
        projectId: parseUuidV7(project.id),
        workItemId: parseUuidV7(workItem.id),
        items: [
          {
            kind: "status_update",
            body: alreadyRejectedBody,
            suggestedChannels: ["work_item_platform_comment"],
          },
        ],
      });
      const alreadyRejectedDraft = await findPendingDraftByBody(
        apiClient,
        owner.authHeaders,
        parseUuidV7(workItem.id),
        alreadyRejectedBody,
      );
      await unwrapAsync(
        apiClient.api["work-item-comment-drafts"]({
          notificationId: alreadyRejectedDraft.notification.id,
        }).reject.post(undefined, { headers: { ...owner.authHeaders } }),
      );

      // Excluded from `/work-item-comment-drafts`: never suggested
      // `work_item_platform_comment` at all, so it never has a delivery row
      // on that channel — only the default `in_app` one. Still visible in
      // the general drawer, same as everything else (Decision 4).
      await emitNotificationSignal({
        apiClient,
        authHeaders: owner.authHeaders,
        projectId: parseUuidV7(project.id),
        workItemId: parseUuidV7(workItem.id),
        items: [
          {
            kind: "feedback_request",
            body: ordinaryInAppBody,
            suggestedChannels: ["in_app"],
          },
        ],
      });

      // Excluded from `/work-item-comment-drafts` when queried for
      // `workItem.id`: right channel/status, wrong work item.
      await emitNotificationSignal({
        apiClient,
        authHeaders: owner.authHeaders,
        projectId: parseUuidV7(project.id),
        workItemId: parseUuidV7(otherWorkItem.id),
        items: [
          {
            kind: "status_update",
            body: otherWorkItemDraftBody,
            suggestedChannels: ["work_item_platform_comment"],
          },
        ],
      });

      const drafts = await unwrapAsync(
        apiClient.api["work-item-comment-drafts"].get({
          query: { workItemId: workItem.id },
          headers: { ...owner.authHeaders },
        }),
      );

      expect(drafts).toHaveLength(1);
      expect(drafts[0]?.notification.body).toBe(pendingDraftBody);
      expect(drafts[0]?.notification.status).toBe("pending");
      expect(drafts[0]?.lastError).toBeNull();
      expect(drafts[0]?.artifactResolution).toBeNull();
      const pendingDraftId = drafts[0]?.notification.id;
      if (!pendingDraftId) throw new Error("Expected a pending draft id");

      // Decision 4 (inverted from the shipped feature's Decision 12): the
      // general drawer no longer excludes anything by kind — both the
      // pending draft (via its own `in_app` delivery) and the ordinary
      // in_app-only notification show up, and the rejected draft's
      // notification remains visible too (only its platform-comment
      // delivery was suppressed, not the whole notification — Decision 5).
      const drawerNotifications = await unwrapAsync(
        apiClient.api
          .projects({ projectId: project.id })
          .notifications.get({
            query: { workItemId: workItem.id },
            headers: { ...owner.authHeaders },
          }),
      );

      expect(
        drawerNotifications.some((n) => n.body === pendingDraftBody),
      ).toBe(true);
      expect(
        drawerNotifications.some((n) => n.body === ordinaryInAppBody),
      ).toBe(true);
      expect(
        drawerNotifications.some((n) => n.body === alreadyRejectedBody),
      ).toBe(true);
      expect(
        drawerNotifications.some((n) => n.body === otherWorkItemDraftBody),
      ).toBe(false);

      // Decision 3, made explicit: the *same* notification simultaneously
      // has an actionable draft (still `"pending"` on the
      // `work_item_platform_comment` channel) and an already-delivered
      // in_app copy (visible in the drawer) — one notification, two
      // independently-resolved channel outcomes.
      const pendingDraftInDrawer = drawerNotifications.find(
        (n) => n.id === pendingDraftId,
      );
      expect(pendingDraftInDrawer).toBeDefined();
      // The notification's own aggregate `status` reflects both outcomes:
      // `deriveStatus(["sent", "pending"])` = `"pending"` (pending takes
      // priority) — confirming the mixed-channel notification remains
      // `"pending"` overall while its `in_app` delivery has already
      // resolved.
      expect(pendingDraftInDrawer?.status).toBe("pending");

      const pendingDraftWithDeliveries = await unwrapAsync(
        apiClient.api
          .projects({ projectId: project.id })
          .notifications({ notificationId: pendingDraftId })
          .get({ headers: { ...owner.authHeaders } }),
      );
      expect(pendingDraftWithDeliveries.deliveries).toHaveLength(2);
      expect(
        pendingDraftWithDeliveries.deliveries.find(
          (d) => d.channel === "in_app",
        )?.status,
      ).toBe("sent");
      expect(
        pendingDraftWithDeliveries.deliveries.find(
          (d) => d.channel === "work_item_platform_comment",
        )?.status,
      ).toBe("pending");
    },
  );

  concurrentTest(
    "mixed-channel notification: in_app delivers immediately while work_item_platform_comment becomes an independent pending draft on the same notification",
    async () => {
      const { owner, project, workItem } = await setup(
        "comment-draft-list-mixed",
      );

      const mixedBody = "Mixed-channel: please review before posting.";

      // Decision 3: a single item suggesting both channels together.
      await emitNotificationSignal({
        apiClient,
        authHeaders: owner.authHeaders,
        projectId: parseUuidV7(project.id),
        workItemId: parseUuidV7(workItem.id),
        items: [
          {
            kind: "warning",
            body: mixedBody,
            suggestedChannels: ["in_app", "work_item_platform_comment"],
          },
        ],
      });

      const draft = await findPendingDraftByBody(
        apiClient,
        owner.authHeaders,
        parseUuidV7(workItem.id),
        mixedBody,
      );
      expect(draft.notification.status).toBe("pending");
      expect(draft.lastError).toBeNull();

      const drawerNotification = await findDrawerNotificationByBody(
        apiClient,
        owner.authHeaders,
        parseUuidV7(project.id),
        parseUuidV7(workItem.id),
        mixedBody,
      );
      expect(drawerNotification).toBeDefined();
      expect(drawerNotification?.id).toBe(draft.notification.id);

      const withDeliveries = await unwrapAsync(
        apiClient.api
          .projects({ projectId: project.id })
          .notifications({ notificationId: draft.notification.id })
          .get({ headers: { ...owner.authHeaders } }),
      );
      expect(withDeliveries.deliveries).toHaveLength(2);
      expect(
        withDeliveries.deliveries.find((d) => d.channel === "in_app")
          ?.status,
      ).toBe("sent");
      expect(
        withDeliveries.deliveries.find(
          (d) => d.channel === "work_item_platform_comment",
        )?.status,
      ).toBe("pending");
    },
  );
});

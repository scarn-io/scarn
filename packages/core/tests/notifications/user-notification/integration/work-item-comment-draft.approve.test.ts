import { describe, expect, test } from "bun:test";
import { createApp } from "@scarn/api/app";
import { createAppContext } from "@/lib/di";
import { fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createScarnTreaty } from "tests/treaty";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { DrizzleUserNotificationRepo } from "@/notifications/user-notification/infra/drizzle-user-notification-repo";
import { DrizzleNotificationDeliveryRepo } from "@/notifications/notification-delivery/infra/drizzle-notification-delivery-repo";
import { useGithubRelationshipsTestEnv } from "../../../integrations/github-ingest/integration/run-project-integration-sync-relationships-test-support";
import { makeCommentDraftFetchImpl } from "./comment-draft-github-fetch-support";
import {
  emitNotificationSignal,
  findPendingDraftByBody,
} from "./emit-notification-signal-support";

/**
 * Exercises the happy path of Phase 5's `approveCommentDraft`: posting the
 * (possibly human-edited) draft body to GitHub, recording a `sent`
 * `notification_deliveries` row, and promoting an agent-authored
 * `work_item_comments` row (Decision 9).
 *
 * The draft notification is seeded through the real signal pipeline
 * (`emitNotificationSignal`) rather than a hand-constructed
 * `kind: "comment_draft"` entity — `comment_draft` no longer exists as a
 * kind (see `docs/plans/route-comment-drafts-by-channel.md`), and a
 * `work_item_platform_comment` draft is now produced by the dispatcher for
 * *any* kind that suggests that channel (Decisions 1/3/8).
 *
 * Reassigns `globalThis.fetch` via `makeCommentDraftFetchImpl` — shared,
 * process-global mutable state — so this file uses plain serial `test`
 * rather than `concurrentTest`, exactly like
 * `run-project-integration-sync.relationships.test.ts`.
 */
describe("approve comment draft — happy path", () => {
  useGithubRelationshipsTestEnv();

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

  test("posts the edited body to GitHub, records a sent delivery, and promotes an agent-authored comment", async () => {
    const owner = await createTestUserAndSession({
      email: `comment-draft-approve-${crypto.randomUUID()}@example.com`,
    });
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Comment Draft Approve Project",
          description: "Project for comment draft approve tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );

    const repoFullName = "acme-org/widgets";
    await unwrapAsync(
      apiClient.api.projects({ projectId: project.id }).integrations.post(
        {
          kind: "github_app",
          installationId: "999",
          externalScope: { repos: [{ id: 1, fullName: repoFullName }] },
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
          platformKey: `${repoFullName}#42`,
          url: null,
          title: "Some GitHub issue",
          description: "Repro steps",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          fields: { repository: repoFullName, number: 42 },
        },
        { headers: { ...owner.authHeaders } },
      ),
    );

    globalThis.fetch = makeCommentDraftFetchImpl({
      owner: "acme-org",
      repo: "widgets",
      issueNumber: 42,
    });

    const draftBody = "Draft: thanks for reporting this.";

    // Seeds via the real signal path: any ordinary kind + suggesting
    // `work_item_platform_comment` (Decision 1/3) — the dispatcher (not this
    // fixture) is what creates the pending `notification_deliveries` row.
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
      // The real signal-processing loop (`CreateUserNotificationsOnStep
      // SignalCreated.handle`) always creates agent-sourced notifications
      // with `agentSessionId: null` today (no agent session is threaded
      // through the notification signal item) — unlike the old
      // hand-rolled fixture, which injected an arbitrary session id
      // directly into the entity.
      agentSessionId: null,
      sourceNotificationId: notificationId,
      body: editedBody,
      externalCommentId: "12345",
      externalCommentUrl:
        "https://github.com/acme-org/widgets/issues/42#issuecomment-12345",
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
    expect(delivery?.externalId).toBe("12345");
    expect(delivery?.externalUrl).toBe(
      "https://github.com/acme-org/widgets/issues/42#issuecomment-12345",
    );
    expect(delivery?.sentAt).not.toBeNull();
    expect(delivery?.suppressionReason).toBeNull();

    // Decisions 3/5/6: this notification also got its own `in_app` delivery
    // at signal-processing time (every notification does, by default —
    // `evaluateNotificationPolicy`'s escape hatch), which resolves to
    // `"sent"` immediately via `InAppNotificationAdapter`. Once the
    // `work_item_platform_comment` delivery is *also* `"sent"` (from this
    // approve call), `deriveStatus(["sent", "sent"])` = `"delivered"` — the
    // same overall status the old single-delivery fixture asserted, now
    // arrived at via two independently-resolved delivery outcomes rather
    // than one.
    const notification = await userNotificationRepo.load(
      parseUuidV7(notificationId),
    );
    expect(notification?.status).toBe("delivered");
    expect(deliveries).toHaveLength(2);
    expect(deliveries.find((d) => d.channel === "in_app")?.status).toBe("sent");
  });
});

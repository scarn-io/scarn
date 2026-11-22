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
  findPendingDraftByBody,
} from "./emit-notification-signal-support";

/**
 * Exercises Decision 5/7: a project member who lacks
 * `work-item-platform-comment:create` (deliberately granted a permission set
 * that excludes it) is denied — via a 403 — on both approve and reject,
 * mirroring `work-item.get.test.ts`'s "returns 403 when the user lacks work
 * item read permission" precedent. Never reassigns `globalThis.fetch` (the
 * request never reaches GitHub, since the permission check runs before any
 * of that), so this file uses `concurrentTest` as normal.
 *
 * The draft notification is seeded through the real signal pipeline
 * (`emitNotificationSignal`) — see `work-item-comment-draft.approve
 * .test.ts` for why (`comment_draft` no longer exists as a kind).
 */
describe("comment draft permission gate", () => {
  const NOW = new Date("2026-04-22T12:00:00.000Z");
  const userNotificationRepo = new DrizzleUserNotificationRepo();
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(NOW),
      userNotificationRepo,
    }),
  );
  const apiClient = createScarnTreaty(app);

  concurrentTest(
    "a member without work-item-platform-comment:create gets 403 on both approve and reject",
    async () => {
      const owner = await createTestUserAndSession({
        email: `comment-draft-perm-owner-${crypto.randomUUID()}@example.com`,
      });
      const member = await createTestUserAndSession({
        email: `comment-draft-perm-member-${crypto.randomUUID()}@example.com`,
      });
      const project = await unwrapAsync(
        apiClient.api.projects.post(
          {
            name: "Comment Draft Permission Project",
            description: "Project for comment draft permission tests",
            gitUrl: "https://github.com/example/test-project.git",
          },
          { headers: { ...owner.authHeaders } },
        ),
      );

      // Deliberately insufficient — excludes work-item-platform-comment:create.
      await unwrapAsync(
        apiClient.api
          .projects({ projectId: project.id })
          .members({ userId: member.userId })
          .role.put({ role: "read" }, { headers: { ...owner.authHeaders } }),
      );

      const workItem = await unwrapAsync(
        apiClient.api["work-items"].post(
          {
            projectId: project.id,
            platform: "github",
            platformId: null,
            platformKey: `acme-org/perm-gated#${crypto.randomUUID()}`,
            url: null,
            title: "A GitHub issue",
            description: "Repro steps",
            sourceCreatedAt: null,
            sourceUpdatedAt: null,
            fields: { repository: "acme-org/perm-gated", number: 1 },
          },
          { headers: { ...owner.authHeaders } },
        ),
      );

      const draftBody = "Draft: permission-gated.";
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

      const approveResult = await apiClient.api["work-item-comment-drafts"]({
        notificationId,
      }).approve.post(
        { body: "Attempted approval" },
        { headers: { ...member.authHeaders } },
      );
      expect(approveResult.data).toBeNull();
      expect(approveResult.error?.status).toBe(403);

      const rejectResult = await apiClient.api["work-item-comment-drafts"]({
        notificationId,
      }).reject.post(undefined, {
        headers: { ...member.authHeaders },
      });
      expect(rejectResult.data).toBeNull();
      expect(rejectResult.error?.status).toBe(403);
    },
  );
});

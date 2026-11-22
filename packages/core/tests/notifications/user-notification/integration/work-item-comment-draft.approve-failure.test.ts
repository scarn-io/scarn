import { describe, expect, test } from "bun:test";
import { createApp } from "@scarn/api/app";
import { createAppContext } from "@/lib/di";
import { fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createScarnTreaty } from "tests/treaty";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";
import { DrizzleUserNotificationRepo } from "@/notifications/user-notification/infra/drizzle-user-notification-repo";
import { DrizzleNotificationDeliveryRepo } from "@/notifications/notification-delivery/infra/drizzle-notification-delivery-repo";
import { useGithubRelationshipsTestEnv } from "../../../integrations/github-ingest/integration/run-project-integration-sync-relationships-test-support";
import {
  COMMENT_POST_FAILURE_MESSAGE,
  makeCommentDraftFetchImpl,
} from "./comment-draft-github-fetch-support";
import {
  emitNotificationSignal,
  findPendingDraftByBody,
} from "./emit-notification-signal-support";

/**
 * Exercises Decision 7/10: a failed GitHub post upserts the delivery row to
 * `failed` (with the error message in `suppressionReason`) and creates no
 * `work_item_comments` row, but stays retryable. Approve is then retried on
 * the *same* notification and succeeds, proving the delivery row is
 * upserted (find-or-create-then-mutate) rather than duplicated.
 *
 * The draft notification is seeded through the real signal pipeline
 * (`emitNotificationSignal`) — see `work-item-comment-draft.approve
 * .test.ts` for why (`comment_draft` no longer exists as a kind).
 *
 * Reassigns `globalThis.fetch` — see `work-item-comment-draft.approve
 * .test.ts` for why this file uses plain serial `test`.
 */
describe("approve comment draft — GitHub post failure", () => {
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

  test("records a failed delivery, leaves the notification's overall status reflecting the mixed outcome, creates no comment row, and can be retried successfully", async () => {
    const owner = await createTestUserAndSession({
      email: `comment-draft-approve-failure-${crypto.randomUUID()}@example.com`,
    });
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Comment Draft Approve Failure Project",
          description: "Project for comment draft approve-failure tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );

    const repoFullName = "acme-org/gadgets";
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
          platformKey: `${repoFullName}#7`,
          url: null,
          title: "Another GitHub issue",
          description: "Repro steps",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          fields: { repository: repoFullName, number: 7 },
        },
        { headers: { ...owner.authHeaders } },
      ),
    );

    const draftBody = "Draft: first attempt.";

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

    // First attempt: GitHub rejects the comment post with a 401.
    globalThis.fetch = makeCommentDraftFetchImpl({
      owner: "acme-org",
      repo: "gadgets",
      issueNumber: 7,
      commentPostShouldFail: true,
    });

    const { data: failedData, error: failedError } = await apiClient.api[
      "work-item-comment-drafts"
    ]({ notificationId }).approve.post(
      { body: "First attempt" },
      { headers: { ...owner.authHeaders } },
    );

    expect(failedData).toBeNull();
    expect(failedError?.status).toBe(502);

    // Two delivery rows now exist: the eagerly-created
    // `work_item_platform_comment` one (this test's concern) and the
    // `in_app` one every notification gets by default (Decision 3/4) —
    // unaffected by this failure, already `"sent"`.
    const deliveriesAfterFailure =
      await notificationDeliveryRepo.listByNotificationId(
        parseUuidV7(notificationId),
      );
    expect(deliveriesAfterFailure).toHaveLength(2);
    const failedDelivery = deliveriesAfterFailure.find(
      (d) => d.channel === "work_item_platform_comment",
    );
    expect(failedDelivery?.status).toBe("failed");
    expect(failedDelivery?.suppressionReason).toContain(
      COMMENT_POST_FAILURE_MESSAGE,
    );
    expect(failedDelivery?.externalId).toBeNull();
    expect(failedDelivery?.sentAt).toBeNull();
    expect(
      deliveriesAfterFailure.find((d) => d.channel === "in_app")?.status,
    ).toBe("sent");

    // Decision 5/7: the notification's overall status is derived from *all*
    // of its deliveries, not hardcoded. With `in_app` already `"sent"` and
    // `work_item_platform_comment` now `"failed"`,
    // `deriveStatus(["sent", "failed"])` = `"partially_delivered"` — not
    // `"pending"` (there is no zero-delivery, "nothing happened yet" case
    // once the eager-creation model is in effect: something has always
    // already resolved by the time a failure can occur). The delivery row
    // itself, not this aggregate status, is what stays actionable/retryable
    // (Decision 7).
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

    // Retry, same notification: GitHub now accepts the post.
    globalThis.fetch = makeCommentDraftFetchImpl({
      owner: "acme-org",
      repo: "gadgets",
      issueNumber: 7,
    });

    const comment = await unwrapAsync(
      apiClient.api["work-item-comment-drafts"]({
        notificationId,
      }).approve.post(
        { body: "Retry attempt" },
        { headers: { ...owner.authHeaders } },
      ),
    );

    expect(comment).toMatchObject({
      authorKind: "agent",
      body: "Retry attempt",
      externalCommentId: "12345",
    });

    // The `work_item_platform_comment` delivery row is mutated in place
    // (load-mutate-save per Decision 8, never a second row for the same
    // channel). Note: `markSent()` does not clear a prior
    // `suppressionReason` — not asserted on here either way.
    const deliveriesAfterRetry =
      await notificationDeliveryRepo.listByNotificationId(
        parseUuidV7(notificationId),
      );
    expect(deliveriesAfterRetry).toHaveLength(2);
    const retriedDelivery = deliveriesAfterRetry.find(
      (d) => d.channel === "work_item_platform_comment",
    );
    expect(retriedDelivery?.status).toBe("sent");
    expect(retriedDelivery?.externalId).toBe("12345");

    // Both deliveries are now `"sent"` -> `deriveStatus(["sent", "sent"])`
    // = `"delivered"`.
    const notificationAfterRetry = await userNotificationRepo.load(
      parseUuidV7(notificationId),
    );
    expect(notificationAfterRetry?.status).toBe("delivered");
  });
});

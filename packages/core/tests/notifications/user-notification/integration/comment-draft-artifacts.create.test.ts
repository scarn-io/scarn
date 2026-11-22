import { describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { createAppContext } from "@/lib/di";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { DrizzleNotificationDeliveryRepo } from "@/notifications/notification-delivery/infra/drizzle-notification-delivery-repo";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { createScarnTreaty } from "tests/treaty";
import {
  emitNotificationSignal,
  findDrawerNotificationByBody,
  findPendingDraftByBody,
} from "./emit-notification-signal-support";
import {
  seedTaskArtifact,
  setupGithubWorkItem,
} from "./comment-artifact-test-support";

/**
 * Resolving a comment draft's artifact markers when the draft is created:
 * the resolved body becomes the draft, unavailable optional markers are left
 * out, and an unavailable required marker suppresses the comment delivery.
 */
describe("comment draft artifact markers — draft creation", () => {
  const notificationDeliveryRepo = new DrizzleNotificationDeliveryRepo();
  const apiClient = createScarnTreaty(
    createApp(createAppContext({ notificationDeliveryRepo })),
  );

  const commentDeliveryOf = async (notificationId: string) => {
    const deliveries = await notificationDeliveryRepo.listByNotificationId(
      parseUuidV7(notificationId),
    );
    return {
      deliveries,
      comment: deliveries.find(
        (d) => d.channel === "work_item_platform_comment",
      ),
    };
  };

  concurrentTest(
    "resolves markers, leaves out unavailable optional ones, and stores the resolution",
    async () => {
      const { authHeaders, projectId, workItemId } = await setupGithubWorkItem(
        apiClient,
        "comment-artifacts-create",
      );
      const stepKey = `record_${crypto.randomUUID().replaceAll("-", "")}`;
      const body = [
        "Found the bug.",
        "",
        `![Repro video](artifact:signal/${stepKey}/reproVideo)`,
        "",
        "![Missing screenshot](artifact:shots/missing-*.png)",
        "",
        "[Console log](artifact:logs/console.txt)",
      ].join("\n");
      const expectedBody = [
        "Found the bug.",
        "",
        `![Repro video](artifact:signal/${stepKey}/reproVideo)`,
        "",
        "[Console log](artifact:logs/console.txt)",
      ].join("\n");

      let videoId = "";
      let logId = "";
      await emitNotificationSignal({
        apiClient,
        authHeaders,
        projectId,
        workItemId,
        stepDefinitionKey: stepKey,
        artifactSignals: [{ key: "reproVideo", reported: "repro.mp4" }],
        beforeComplete: async ({ taskId }) => {
          videoId = await seedTaskArtifact({
            projectId,
            taskId,
            relativeStorePath: "repro.mp4",
            contentType: "video/mp4",
            kind: "video",
          });
          logId = await seedTaskArtifact({
            projectId,
            taskId,
            relativeStorePath: "logs/console.txt",
            contentType: "text/plain",
            kind: "text",
          });
        },
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
        authHeaders,
        workItemId,
        expectedBody,
      );
      const { comment } = await commentDeliveryOf(draft.notification.id);

      expect(comment?.status).toBe("pending");
      expect(comment?.artifactResolutionJson).toMatchObject({
        markers: [
          {
            markerIndex: 0,
            kind: "embed",
            ref: { type: "signal", stepKey, signalKey: "reproVideo" },
            status: "resolved",
            required: true,
            artifact: { artifactId: videoId, name: "repro.mp4" },
          },
          {
            markerIndex: 1,
            kind: "link",
            ref: { type: "path", pattern: "logs/console.txt" },
            status: "resolved",
            required: false,
            artifact: { artifactId: logId },
          },
        ],
        leftOut: [
          {
            markerIndex: 1,
            ref: { type: "path", pattern: "shots/missing-*.png" },
            caption: "Missing screenshot",
            reason: "no_match",
          },
        ],
        warnings: [],
        outcomes: null,
      });
      expect(draft.artifactResolution).toMatchObject({
        markers: [
          {
            markerIndex: 0,
            status: "resolved",
            artifact: { artifactId: videoId },
          },
          {
            markerIndex: 1,
            status: "resolved",
            artifact: { artifactId: logId },
          },
        ],
        leftOut: [{ caption: "Missing screenshot", reason: "no_match" }],
      });
      expect(draft.artifactResolution).not.toHaveProperty("outcomes");
    },
  );

  concurrentTest(
    "suppresses the comment delivery when a required artifact is unavailable",
    async () => {
      const { authHeaders, projectId, workItemId } = await setupGithubWorkItem(
        apiClient,
        "comment-artifacts-suppress",
      );
      const stepKey = `record_${crypto.randomUUID().replaceAll("-", "")}`;
      const body = `Repro below.\n\n![Repro video](artifact:signal/${stepKey}/reproVideo)`;

      await emitNotificationSignal({
        apiClient,
        authHeaders,
        projectId,
        workItemId,
        stepDefinitionKey: stepKey,
        artifactSignals: [{ key: "reproVideo", reported: null }],
        items: [
          {
            kind: "status_update",
            body,
            suggestedChannels: ["work_item_platform_comment"],
            payload: { source: "test" },
          },
        ],
      });

      const notification = await findDrawerNotificationByBody(
        apiClient,
        authHeaders,
        projectId,
        workItemId,
        body,
      );
      expect(notification).toBeDefined();
      expect(notification?.payloadJson).toEqual({
        source: "test",
        commentSuppressed: {
          reason: "not_reported",
          artifact: {
            stepKey,
            signalKey: "reproVideo",
            caption: "Repro video",
          },
        },
      });

      const drafts = await unwrapAsync(
        apiClient.api["work-item-comment-drafts"].get({
          query: { workItemId },
          headers: { ...authHeaders },
        }),
      );
      expect(drafts).toEqual([]);

      const { deliveries, comment } = await commentDeliveryOf(
        notification?.id ?? "",
      );
      expect(comment).toMatchObject({
        status: "suppressed",
        suppressionReason: "artifact_unavailable",
        artifactResolutionJson: null,
      });
      expect(deliveries.find((d) => d.channel === "in_app")?.status).toBe(
        "sent",
      );
    },
  );
});

import { describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { createAppContext } from "@/lib/di";
import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { artifactShares, taskArtifactBundles } from "@/lib/db/schema";
import { DrizzleCommentArtifactReader } from "@/notifications/comment-artifacts/infra/drizzle-comment-artifact-reader";
import { DrizzleNotificationDeliveryRepo } from "@/notifications/notification-delivery/infra/drizzle-notification-delivery-repo";
import { createArtifactSharingConfig } from "@/tasks/artifact-share/domain/artifact-sharing-config";
import { concurrentTest } from "tests/utils";
import { createScarnTreaty } from "tests/treaty";
import {
  emitNotificationSignal,
  findPendingDraftByBody,
} from "./emit-notification-signal-support";
import { setupGithubWorkItem } from "./comment-artifact-test-support";

const seedBundle = async (input: {
  projectId: UuidV7;
  taskId: UuidV7;
  name: string;
  fieldPath?: string;
}): Promise<UuidV7> => {
  const id = createUuidV7();
  await getDb()
    .insert(taskArtifactBundles)
    .values({
      id,
      projectId: input.projectId,
      taskRunId: input.taskId,
      name: input.name,
      fieldPath: input.fieldPath ?? null,
      rootPath: input.name,
      entryPath: "index.html",
      status: "ready",
      fileCount: 1,
      sizeBytes: 10,
      finalizedAt: new Date(),
    });
  return id;
};

const seedShare = async (input: {
  projectId: UuidV7;
  bundleId: UuidV7;
  revoked?: boolean;
}): Promise<UuidV7> => {
  const id = createUuidV7();
  await getDb()
    .insert(artifactShares)
    .values({
      id,
      projectId: input.projectId,
      bundleId: input.bundleId,
      createdVia: "step",
      revokedAt: input.revoked ? new Date() : null,
    });
  return id;
};

/**
 * Comment markers that point at artifact bundles: a signal marker resolves
 * to the bundle filling that field, a path marker ending in `/` to a bundle
 * by name, and the reader reports each bundle's active share.
 */
describe("comment draft artifact markers — bundles", () => {
  const notificationDeliveryRepo = new DrizzleNotificationDeliveryRepo();
  const apiClient = createScarnTreaty(
    createApp(
      createAppContext({
        notificationDeliveryRepo,
        artifactSharingConfig: createArtifactSharingConfig({
          contentUrl: "https://content.test",
          shareSecret: "share-secret",
        }),
      }),
    ),
  );
  const reader = new DrizzleCommentArtifactReader();

  concurrentTest(
    "resolves signal and path markers to bundles with their active share",
    async () => {
      const { authHeaders, projectId, workItemId } = await setupGithubWorkItem(
        apiClient,
        "comment-artifacts-bundles",
      );
      const stepKey = `reproduce_${crypto.randomUUID().replaceAll("-", "")}`;
      const body = [
        `[Full report](artifact:signal/${stepKey}/report)`,
        "",
        "[Coverage](artifact:coverage/)",
      ].join("\n");

      let reportId = createUuidV7();
      let coverageId = createUuidV7();
      let shareId = createUuidV7();
      const emitted = await emitNotificationSignal({
        apiClient,
        authHeaders,
        projectId,
        workItemId,
        stepDefinitionKey: stepKey,
        artifactSignals: [{ key: "report", reported: "report" }],
        beforeComplete: async ({ taskId }) => {
          reportId = await seedBundle({
            projectId,
            taskId,
            name: "report",
            fieldPath: "report",
          });
          await seedShare({ projectId, bundleId: reportId, revoked: true });
          shareId = await seedShare({ projectId, bundleId: reportId });
          coverageId = await seedBundle({
            projectId,
            taskId,
            name: "coverage",
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
        body,
      );
      expect(draft.artifactResolution?.markers).toMatchObject([
        {
          status: "resolved",
          required: true,
          artifact: { artifactId: reportId, name: "report", kind: "bundle" },
        },
        {
          status: "resolved",
          required: false,
          artifact: {
            artifactId: coverageId,
            name: "coverage",
            kind: "bundle",
          },
        },
      ]);
      const deliveries = await notificationDeliveryRepo.listByNotificationId(
        parseUuidV7(draft.notification.id),
      );
      expect(JSON.stringify(deliveries)).not.toContain("content.test");

      const stepBundle = await reader.findLatestStepBundle({
        pipelineRunId: emitted.pipelineRunId,
        stepKey,
        fieldPath: "report",
      });
      expect(stepBundle).toMatchObject({
        id: reportId,
        status: "ready",
        activeShareId: shareId,
      });

      const bundles = await reader.listRunBundles(emitted.pipelineRunId);
      const sharesById = new Map(
        bundles.map(({ id, activeShareId }) => [id, activeShareId]),
      );
      expect(sharesById).toEqual(
        new Map([
          [reportId, shareId],
          [coverageId, null],
        ]),
      );
    },
  );
});

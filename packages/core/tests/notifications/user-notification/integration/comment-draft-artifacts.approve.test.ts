import { describe, expect, test } from "bun:test";
import { createApp } from "@scarn/api/app";
import { createAppContext } from "@/lib/di";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { DrizzleNotificationDeliveryRepo } from "@/notifications/notification-delivery/infra/drizzle-notification-delivery-repo";
import { unwrapAsync } from "tests/utils";
import { createScarnTreaty } from "tests/treaty";
import { useGithubRelationshipsTestEnv } from "../../../integrations/github-ingest/integration/run-project-integration-sync-relationships-test-support";
import { makeCommentDraftFetchImpl } from "./comment-draft-github-fetch-support";
import {
  emitNotificationSignal,
  findPendingDraftByBody,
} from "./emit-notification-signal-support";
import {
  ISSUE_NUMBER,
  deleteTaskArtifact,
  seedTaskArtifact,
  setupGithubWorkItem,
} from "./comment-artifact-test-support";

const captureCommentPosts = (): { bodies: string[] } => {
  const captured = { bodies: [] as string[] };
  const inner = makeCommentDraftFetchImpl({
    owner: "acme-org",
    repo: "artifacts",
    issueNumber: ISSUE_NUMBER,
  });
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url.includes("/comments") && typeof init?.body === "string") {
      const parsed = JSON.parse(init.body) as { body?: string };
      if (parsed.body !== undefined) captured.bodies.push(parsed.body);
    }
    return inner(input, init);
  }) as typeof fetch;
  return captured;
};

/**
 * Approving a comment draft with artifact markers: every marker is
 * re-resolved, rendered as a Scarn link on GitHub, and its outcome is
 * recorded; an artifact that has become unavailable blocks approval.
 *
 * Reassigns `globalThis.fetch`, so this file uses plain serial `test`.
 */
describe("comment draft artifact markers — approval", () => {
  useGithubRelationshipsTestEnv();

  const notificationDeliveryRepo = new DrizzleNotificationDeliveryRepo();
  const apiClient = createScarnTreaty(
    createApp(createAppContext({ notificationDeliveryRepo })),
  );
  const appUrl = process.env["APP_URL"] ?? "";

  const seedDraft = async (label: string) => {
    const { authHeaders, projectId, workItemId } = await setupGithubWorkItem(
      apiClient,
      label,
    );
    const stepKey = `record_${crypto.randomUUID().replaceAll("-", "")}`;
    const body = [
      "Here is the repro.",
      "",
      `![Repro video](artifact:signal/${stepKey}/reproVideo)`,
      "",
      "See [the console log](artifact:logs/console.txt) too.",
    ].join("\n");

    const ids: { video: UuidV7 | null; log: UuidV7 | null } = {
      video: null,
      log: null,
    };
    await emitNotificationSignal({
      apiClient,
      authHeaders,
      projectId,
      workItemId,
      stepDefinitionKey: stepKey,
      artifactSignals: [{ key: "reproVideo", reported: "media/repro.mp4" }],
      beforeComplete: async ({ taskId }) => {
        ids.video = await seedTaskArtifact({
          projectId,
          taskId,
          relativeStorePath: "media/repro.mp4",
          contentType: "video/mp4",
          kind: "video",
        });
        ids.log = await seedTaskArtifact({
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
      body,
    );
    if (!ids.video || !ids.log) throw new Error("Expected seeded artifacts");
    return {
      authHeaders,
      projectId,
      body,
      notificationId: draft.notification.id,
      videoId: ids.video,
      logId: ids.log,
    };
  };

  test("posts markers as Scarn links and records the outcomes", async () => {
    const captured = captureCommentPosts();
    const { authHeaders, projectId, body, notificationId, videoId, logId } =
      await seedDraft("comment-artifacts-approve");

    const comment = await unwrapAsync(
      apiClient.api["work-item-comment-drafts"]({
        notificationId,
      }).approve.post({ body }, { headers: { ...authHeaders } }),
    );

    const pageUrl = (artifactId: string) =>
      `${appUrl}/projects/${projectId}/artifacts/${artifactId}`;
    const expectedBody = [
      "Here is the repro.",
      "",
      "Repro video",
      `[View repro.mp4 in Scarn](${pageUrl(videoId)})`,
      "",
      `See [the console log](${pageUrl(logId)}) too.`,
    ].join("\n");
    expect(captured.bodies).toEqual([expectedBody]);
    expect(comment.body).toBe(expectedBody);

    const deliveries = await notificationDeliveryRepo.listByNotificationId(
      parseUuidV7(notificationId),
    );
    const delivery = deliveries.find(
      (d) => d.channel === "work_item_platform_comment",
    );
    expect(delivery?.status).toBe("sent");
    expect(delivery?.artifactResolutionJson).toMatchObject({
      markers: [
        {
          markerIndex: 0,
          status: "resolved",
          artifact: { artifactId: videoId },
        },
        {
          markerIndex: 1,
          status: "resolved",
          standalone: false,
          artifact: { artifactId: logId },
        },
      ],
      warnings: [{ markerIndex: 1, code: "marker_not_standalone" }],
      outcomes: [
        {
          markerIndex: 0,
          artifactId: videoId,
          platform: "github",
          outcome: "linked",
          externalRef: null,
        },
        {
          markerIndex: 1,
          artifactId: logId,
          platform: "github",
          outcome: "linked",
          externalRef: null,
        },
      ],
    });
  });

  test("rejects approval when an artifact has become unavailable", async () => {
    const captured = captureCommentPosts();
    const { authHeaders, body, notificationId, logId } = await seedDraft(
      "comment-artifacts-approve-unavailable",
    );
    await deleteTaskArtifact(logId);

    const { error } = await apiClient.api["work-item-comment-drafts"]({
      notificationId,
    }).approve.post({ body }, { headers: { ...authHeaders } });

    expect(error?.status).toBe(422);
    expect(error?.value).toMatchObject({
      code: "artifact_unavailable",
      meta: {
        markers: [
          { markerIndex: 1, caption: "the console log", reason: "no_match" },
        ],
      },
    });
    expect(captured.bodies).toEqual([]);

    const deliveries = await notificationDeliveryRepo.listByNotificationId(
      parseUuidV7(notificationId),
    );
    expect(
      deliveries.find((d) => d.channel === "work_item_platform_comment")
        ?.status,
    ).toBe("pending");

    const withoutLog = body.replace(
      " [the console log](artifact:logs/console.txt)",
      "",
    );
    const comment = await unwrapAsync(
      apiClient.api["work-item-comment-drafts"]({
        notificationId,
      }).approve.post({ body: withoutLog }, { headers: { ...authHeaders } }),
    );
    expect(comment.body).not.toContain("console");
    expect(captured.bodies).toHaveLength(1);
  });
});

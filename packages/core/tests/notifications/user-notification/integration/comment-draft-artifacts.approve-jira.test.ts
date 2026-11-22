import { afterEach, describe, expect, mock, test } from "bun:test";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { InMemoryObjectStore } from "@/artifacts/infra/in-memory-object-store";
import { unwrapAsync } from "tests/utils";
import { createScarnTreaty } from "tests/treaty";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import {
  installJiraCommentClientMock,
  MOCKED_JIRA_COMMENT_ID,
  uninstallJiraCommentClientMock,
} from "./comment-draft-jira-fetch-support";
import {
  emitNotificationSignal,
  findPendingDraftByBody,
} from "./emit-notification-signal-support";
import { seedTaskArtifact } from "./comment-artifact-test-support";

const BASE_URL = "https://acme.atlassian.net";
const MEDIA_ID = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";
const CLIENT_ID = "11111111-2222-4333-8444-555555555555";
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

const originalFetch = globalThis.fetch;

/** Fakes Jira's attachment upload and content-redirect endpoints. */
const installJiraAttachmentFetch = () => {
  const uploads: Array<{ url: string; fileName: string; type: string }> = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url === `${BASE_URL}/rest/api/3/issue/PROJ-9/attachments`) {
      const file = (init?.body as FormData).get("file") as File;
      uploads.push({ url, fileName: file.name, type: file.type });
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG_BYTES);
      return Response.json([{ id: "10001", mimeType: file.type }]);
    }
    if (url === `${BASE_URL}/rest/api/3/attachment/content/10001`) {
      return new Response(null, {
        status: 303,
        headers: {
          location: `https://api.media.atlassian.com/file/${MEDIA_ID}/binary?token=tok&client=${CLIENT_ID}`,
        },
      });
    }
    throw new Error(`Unexpected fetch ${url}`);
  }) as typeof fetch;
  return { uploads };
};

/**
 * Approving a Jira draft with artifact markers: a standalone PNG is attached
 * to the issue and embedded inline, its outcome is saved before the comment
 * is posted, and a retry after a failed post reuses that outcome rather than
 * uploading again.
 *
 * Uses `mock.module` and reassigns `globalThis.fetch`, so tests are serial.
 */
describe("comment draft artifact markers — Jira approval", () => {
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await uninstallJiraCommentClientMock();
    mock.restore();
  });

  test("embeds the PNG, links the log, and never uploads twice on retry", async () => {
    const { calls } = await installJiraCommentClientMock({
      failTimes: 1,
      failureStatus: 500,
    });
    const { uploads } = installJiraAttachmentFetch();

    const { createApp } = await import("@scarn/api/app");
    const { createAppContext } = await import("@/lib/di");
    const { DrizzleNotificationDeliveryRepo } =
      await import("@/notifications/notification-delivery/infra/drizzle-notification-delivery-repo");
    const objectStore = new InMemoryObjectStore();
    const notificationDeliveryRepo = new DrizzleNotificationDeliveryRepo();
    const apiClient = createScarnTreaty(
      createApp(createAppContext({ objectStore, notificationDeliveryRepo })),
    );
    const appUrl = (process.env["APP_URL"] ?? "").replace(/\/+$/, "");

    const owner = await createTestUserAndSession({
      email: `comment-artifacts-jira-${crypto.randomUUID()}@example.com`,
    });
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Jira artifacts project",
          description: "Project for Jira artifact embedding tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    const projectId = parseUuidV7(project.id);
    await unwrapAsync(
      apiClient.api
        .projects({ projectId })
        .integrations.post(
          {
            kind: "jira",
            externalScope: { baseUrl: BASE_URL, projectKeys: ["PROJ"] },
          },
          { headers: { ...owner.authHeaders } },
        ),
    );
    const workItem = await unwrapAsync(
      apiClient.api["work-items"].post(
        {
          projectId,
          platform: "jira",
          platformId: null,
          platformKey: "PROJ-9",
          url: null,
          title: "Jira issue with artifacts",
          description: "Repro steps",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          fields: null,
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    const workItemId = parseUuidV7(workItem.id);

    const stepKey = `shoot_${crypto.randomUUID().replaceAll("-", "")}`;
    const body = [
      "Found it.",
      "",
      `![Home page](artifact:signal/${stepKey}/homeShot)`,
      "",
      "See [the log](artifact:logs/run.txt).",
    ].join("\n");
    const ids: { shot: UuidV7 | null; log: UuidV7 | null } = {
      shot: null,
      log: null,
    };
    await emitNotificationSignal({
      apiClient,
      authHeaders: owner.authHeaders,
      projectId,
      workItemId,
      stepDefinitionKey: stepKey,
      artifactSignals: [{ key: "homeShot", reported: "shots/home.png" }],
      beforeComplete: async ({ taskId }) => {
        ids.shot = await seedTaskArtifact({
          projectId,
          taskId,
          relativeStorePath: "shots/home.png",
        });
        await objectStore.putObject({
          key: `artifacts/${projectId}/${taskId}/shots/home.png`,
          body: PNG_BYTES,
          contentType: "image/png",
          compress: true,
        });
        ids.log = await seedTaskArtifact({
          projectId,
          taskId,
          relativeStorePath: "logs/run.txt",
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
      owner.authHeaders,
      workItemId,
      body,
    );
    const notificationId = draft.notification.id;
    const { shot, log } = ids;
    if (!shot || !log) throw new Error("Expected seeded artifacts");

    const approve = () =>
      apiClient.api["work-item-comment-drafts"]({
        notificationId,
      }).approve.post(
        {
          body,
          credential: { email: "approver@acme.com", apiKey: "jira-api-key" },
        },
        { headers: { ...owner.authHeaders } },
      );
    const loadDelivery = async () =>
      (
        await notificationDeliveryRepo.listByNotificationId(
          parseUuidV7(notificationId),
        )
      ).find((d) => d.channel === "work_item_platform_comment");

    const embedded = {
      markerIndex: 0,
      artifactId: shot,
      platform: "jira",
      outcome: "embedded",
      externalRef: `jira-attachment:10001/media:${MEDIA_ID}`,
    };

    const first = await approve();
    expect(first.error?.status).toBe(502);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({
      fileName: "home.png",
      type: "image/png",
    });
    const failed = await loadDelivery();
    expect(failed?.status).toBe("failed");
    expect(failed?.artifactResolutionJson?.["outcomes"]).toEqual([embedded]);

    const comment = await unwrapAsync(approve());
    expect(comment.externalCommentId).toBe(MOCKED_JIRA_COMMENT_ID);
    expect(uploads).toHaveLength(1);
    expect(calls).toHaveLength(2);

    const pageUrl = (artifactId: string) =>
      `${appUrl}/projects/${projectId}/artifacts/${artifactId}`;
    expect(calls[1]?.document).toEqual({
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Found it." }] },
        { type: "paragraph", content: [{ type: "text", text: "Home page" }] },
        {
          type: "mediaSingle",
          attrs: { layout: "center" },
          content: [
            {
              type: "media",
              attrs: {
                type: "file",
                id: MEDIA_ID,
                collection: "",
                alt: "Home page",
              },
            },
          ],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "See " },
            {
              type: "text",
              text: "the log",
              marks: [{ type: "link", attrs: { href: pageUrl(log) } }],
            },
            { type: "text", text: "." },
          ],
        },
      ],
    });
    expect(comment.body).toContain(`(${pageUrl(shot)})`);

    const sent = await loadDelivery();
    expect(sent?.status).toBe("sent");
    expect(sent?.artifactResolutionJson).toMatchObject({
      markers: [
        { markerIndex: 0, status: "resolved" },
        { markerIndex: 1, status: "resolved" },
      ],
      outcomes: [
        embedded,
        {
          markerIndex: 1,
          artifactId: log,
          platform: "jira",
          outcome: "linked",
          externalRef: null,
        },
      ],
    });
  });
});

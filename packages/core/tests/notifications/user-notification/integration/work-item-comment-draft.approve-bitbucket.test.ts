import { describe, expect, test } from "bun:test";
import { createApp } from "@scarn/api/app";
import { createAppContext } from "@/lib/di";
import { fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createScarnTreaty } from "tests/treaty";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { useGithubRelationshipsTestEnv } from "../../../integrations/github-ingest/integration/run-project-integration-sync-relationships-test-support";
import {
  emitNotificationSignal,
  findPendingDraftByBody,
} from "./emit-notification-signal-support";

/**
 * Approving a draft on a `bitbucket` integration posts the comment with the
 * approver's own Atlassian email + API token, so the credential is required
 * and a Bitbucket 401 surfaces as `BITBUCKET_API_TOKEN_REJECTED` without
 * echoing the token.
 *
 * Reassigns `globalThis.fetch`, so the tests run serially.
 */
describe("approve comment draft — bitbucket integration", () => {
  useGithubRelationshipsTestEnv();

  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-04-22T12:00:00.000Z")),
    }),
  );
  const apiClient = createScarnTreaty(app);
  const repoFullName = "acme/gadgets";

  const seedDraft = async (draftBody: string) => {
    const owner = await createTestUserAndSession({
      email: `comment-draft-approve-bitbucket-${crypto.randomUUID()}@example.com`,
    });
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Bitbucket Approve Project",
          description: "Project for bitbucket approve tests",
          gitUrl: "https://bitbucket.org/acme/gadgets.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    await unwrapAsync(
      apiClient.api.projects({ projectId: project.id }).integrations.post(
        {
          kind: "bitbucket",
          externalScope: {
            repos: [
              { workspace: "acme", slug: "gadgets", fullName: repoFullName },
            ],
          },
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    const workItem = await unwrapAsync(
      apiClient.api["work-items"].post(
        {
          projectId: project.id,
          platform: "bitbucket",
          platformId: `${repoFullName}#7`,
          platformKey: `${repoFullName}#7`,
          url: null,
          title: "Bitbucket issue",
          description: "Repro",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          fields: { repository: repoFullName, number: 7 },
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
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
    const draft = await findPendingDraftByBody(
      apiClient,
      owner.authHeaders,
      parseUuidV7(workItem.id),
      draftBody,
    );
    return { owner, notificationId: draft.notification.id };
  };

  const stubCommentPost = (status: number) => {
    const requests: { url: string; authorization: string }[] = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (!url.startsWith("https://api.bitbucket.org/2.0/repositories/")) {
        throw new Error(`Unexpected fetch to ${url}`);
      }
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization") ?? "",
      });
      const body =
        status === 201
          ? {
              id: 555,
              links: {
                html: {
                  href: `https://bitbucket.org/${repoFullName}/issues/7#comment-555`,
                },
              },
            }
          : { type: "error" };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;
    return requests;
  };

  test("posts with the approver's pasted email and token", async () => {
    const { owner, notificationId } = await seedDraft("Draft: bitbucket ok");
    const requests = stubCommentPost(201);

    const comment = await unwrapAsync(
      apiClient.api["work-item-comment-drafts"]({
        notificationId,
      }).approve.post(
        {
          body: "Posted with my token",
          credential: { email: "me@acme.test", apiToken: "bb-mine" },
        },
        { headers: { ...owner.authHeaders } },
      ),
    );

    expect(comment).toMatchObject({ externalCommentId: "555" });
    expect(requests).toEqual([
      {
        url: `https://api.bitbucket.org/2.0/repositories/acme/gadgets/issues/7/comments`,
        authorization: `Basic ${Buffer.from("me@acme.test:bb-mine").toString("base64")}`,
      },
    ]);
  });

  test("without a credential it is BITBUCKET_API_TOKEN_REQUIRED and nothing is posted", async () => {
    const { owner, notificationId } = await seedDraft("Draft: bb missing");
    const requests = stubCommentPost(201);

    const { error } = await apiClient.api["work-item-comment-drafts"]({
      notificationId,
    }).approve.post(
      { body: "No token" },
      { headers: { ...owner.authHeaders } },
    );

    expect(error?.status).toBe(400);
    expect(error?.value).toMatchObject({
      code: "BITBUCKET_API_TOKEN_REQUIRED",
    });
    expect(requests).toHaveLength(0);
  });

  test("a Bitbucket 401 is BITBUCKET_API_TOKEN_REJECTED without the token", async () => {
    const { owner, notificationId } = await seedDraft("Draft: bb bad");
    stubCommentPost(401);

    const { error } = await apiClient.api["work-item-comment-drafts"]({
      notificationId,
    }).approve.post(
      {
        body: "Bad token",
        credential: { email: "me@acme.test", apiToken: "bb-revoked-secret" },
      },
      { headers: { ...owner.authHeaders } },
    );

    expect(error?.status).toBe(400);
    expect(error?.value).toMatchObject({
      code: "BITBUCKET_API_TOKEN_REJECTED",
    });
    expect(JSON.stringify(error?.value)).not.toContain("bb-revoked-secret");
  });
});

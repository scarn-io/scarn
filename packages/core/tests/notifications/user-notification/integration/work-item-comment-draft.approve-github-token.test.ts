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
 * Approving a draft on a `github_token` integration posts the comment with
 * the approver's own token rather than an installation token, so the
 * credential is required and a GitHub 401 surfaces as
 * `GITHUB_TOKEN_REJECTED` without echoing the token.
 *
 * Reassigns `globalThis.fetch`, so the tests run serially.
 */
describe("approve comment draft — github_token integration", () => {
  useGithubRelationshipsTestEnv();

  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-04-22T12:00:00.000Z")),
    }),
  );
  const apiClient = createScarnTreaty(app);
  const repoFullName = "acme-org/private-gadgets";

  const seedDraft = async (draftBody: string) => {
    const owner = await createTestUserAndSession({
      email: `comment-draft-approve-token-${crypto.randomUUID()}@example.com`,
    });
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Token Approve Project",
          description: "Project for github_token approve tests",
          gitUrl: "https://gitlab.com/x/y.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    await unwrapAsync(
      apiClient.api.projects({ projectId: project.id }).integrations.post(
        {
          kind: "github_token",
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
          title: "Token issue",
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
    const authorizations: string[] = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (!url.includes("/comments")) {
        throw new Error(`Unexpected fetch to ${url}`);
      }
      authorizations.push(
        new Headers(init?.headers).get("authorization") ?? "",
      );
      const body =
        status === 201
          ? { id: 777, html_url: `https://github.com/${repoFullName}/issues/7` }
          : { message: "Bad credentials" };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;
    return authorizations;
  };

  test("posts with the approver's pasted token", async () => {
    const { owner, notificationId } = await seedDraft("Draft: token ok");
    const authorizations = stubCommentPost(201);

    const comment = await unwrapAsync(
      apiClient.api["work-item-comment-drafts"]({
        notificationId,
      }).approve.post(
        { body: "Posted with my token", credential: { token: "ghp_mine" } },
        { headers: { ...owner.authHeaders } },
      ),
    );

    expect(comment).toMatchObject({ externalCommentId: "777" });
    expect(authorizations).toHaveLength(1);
    expect(authorizations[0]).toContain("ghp_mine");
  });

  test("without a credential it is GITHUB_TOKEN_REQUIRED and nothing is posted", async () => {
    const { owner, notificationId } = await seedDraft("Draft: token missing");
    const authorizations = stubCommentPost(201);

    const { error } = await apiClient.api["work-item-comment-drafts"]({
      notificationId,
    }).approve.post(
      { body: "No token" },
      { headers: { ...owner.authHeaders } },
    );

    expect(error?.status).toBe(400);
    expect(error?.value).toMatchObject({ code: "GITHUB_TOKEN_REQUIRED" });
    expect(authorizations).toHaveLength(0);
  });

  test("a GitHub 401 is GITHUB_TOKEN_REJECTED without the token", async () => {
    const { owner, notificationId } = await seedDraft("Draft: token bad");
    stubCommentPost(401);

    const { error } = await apiClient.api["work-item-comment-drafts"]({
      notificationId,
    }).approve.post(
      { body: "Bad token", credential: { token: "ghp_revoked_secret" } },
      { headers: { ...owner.authHeaders } },
    );

    expect(error?.status).toBe(400);
    expect(error?.value).toMatchObject({ code: "GITHUB_TOKEN_REJECTED" });
    expect(JSON.stringify(error?.value)).not.toContain("ghp_revoked_secret");
  });
});

import { describe, expect, test } from "bun:test";
import { createApp } from "@scarn/api/app";
import { createAppContext } from "@/lib/di";
import { fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createScarnTreaty } from "tests/treaty";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";
import { useGithubRelationshipsTestEnv } from "tests/integrations/github-ingest/integration/run-project-integration-sync-relationships-test-support";
import { makeCommentDraftFetchImpl } from "tests/notifications/user-notification/integration/comment-draft-github-fetch-support";
import {
  emitNotificationSignal,
  findPendingDraftByBody,
} from "tests/notifications/user-notification/integration/emit-notification-signal-support";
import { createTestUserAndSession } from "./auth-test-utils";

/**
 * The `failed`/`sent` half of `awaitingApproval` for
 * `GET /projects/:projectId/work-items` (Phase 1 of
 * `docs/plans/awaiting-approval-filter.md`), split out from
 * `project-work-items.awaiting-approval.test.ts` to keep that file under the
 * repo's `max-lines` limit.
 *
 * Reaching `failed` or `sent` on the `work_item_platform_comment` channel
 * requires a real approve attempt against GitHub, so this file mutates
 * `globalThis.fetch` (via `makeCommentDraftFetchImpl`) and runs as a plain,
 * ordered `test()` — the same precedent
 * `work-item-comment-draft.approve.test.ts` and
 * `work-item-comment-draft.approve-failure.test.ts` follow.
 */
describe("project work items awaiting approval filter — github-backed statuses", () => {
  useGithubRelationshipsTestEnv();

  const NOW = new Date("2026-04-26T12:00:00.000Z");
  const app = createApp(
    createAppContext({ timeProvider: fixedTimeProvider(NOW) }),
  );
  const apiClient = createScarnTreaty(app);

  test("a failed draft still matches the filter; approving a different draft flips it out of the filter, zeroes its count, and creates a comment row", async () => {
    const owner = await createTestUserAndSession({
      email: `awaiting-approval-github-${crypto.randomUUID()}@example.com`,
    });
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Awaiting Approval GitHub Project",
          description: "Project for the awaiting-approval GitHub-backed suite",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );

    const repoFullName = "acme-org/awaiting-approval";
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

    const listByTitle = async (title: string, awaitingApproval?: boolean) =>
      await unwrapAsync(
        apiClient.api.projects({ projectId: project.id })["work-items"].get({
          query: {
            page: 1,
            pageSize: 25,
            q: title,
            ...(awaitingApproval !== undefined
              ? { awaitingApproval: String(awaitingApproval) }
              : {}),
          },
          headers: { ...owner.authHeaders },
        }),
      );

    // --- A failed post is still an actionable draft (decision 3): still
    // matches the filter. ---
    const failedItemTitle = `awaiting-failed-${crypto.randomUUID()}`;
    const failedWorkItem = await unwrapAsync(
      apiClient.api["work-items"].post(
        {
          projectId: project.id,
          platform: "github",
          platformId: null,
          platformKey: `${repoFullName}#1`,
          url: null,
          title: failedItemTitle,
          description: "Repro steps",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          fields: { repository: repoFullName, number: 1 },
        },
        { headers: { ...owner.authHeaders } },
      ),
    );

    const failedBody = `Draft that will fail to post for ${failedItemTitle}`;
    await emitNotificationSignal({
      apiClient,
      authHeaders: owner.authHeaders,
      projectId: parseUuidV7(project.id),
      workItemId: parseUuidV7(failedWorkItem.id),
      items: [
        {
          kind: "status_update",
          body: failedBody,
          suggestedChannels: ["work_item_platform_comment"],
        },
      ],
    });
    const failedDraft = await findPendingDraftByBody(
      apiClient,
      owner.authHeaders,
      parseUuidV7(failedWorkItem.id),
      failedBody,
    );

    globalThis.fetch = makeCommentDraftFetchImpl({
      owner: "acme-org",
      repo: "awaiting-approval",
      issueNumber: 1,
      commentPostShouldFail: true,
    });

    const { error: approveError } = await apiClient.api[
      "work-item-comment-drafts"
    ]({ notificationId: failedDraft.notification.id }).approve.post(
      { body: "Attempted post" },
      { headers: { ...owner.authHeaders } },
    );
    expect(approveError?.status).toBe(502);

    const failedPage = await listByTitle(failedItemTitle, true);
    expect(failedPage.items.map((item) => item.title)).toEqual([
      failedItemTitle,
    ]);
    expect(failedPage.items[0]?.awaitingApprovalCount).toBe(1);

    // --- A separate item's draft, approved successfully: this also covers
    // "an item with only a sent draft does not match" — before approval its
    // (still-pending) draft matches, after approval it does not. ---
    const approvedItemTitle = `awaiting-approved-${crypto.randomUUID()}`;
    const approvedWorkItem = await unwrapAsync(
      apiClient.api["work-items"].post(
        {
          projectId: project.id,
          platform: "github",
          platformId: null,
          platformKey: `${repoFullName}#2`,
          url: null,
          title: approvedItemTitle,
          description: "Repro steps",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          fields: { repository: repoFullName, number: 2 },
        },
        { headers: { ...owner.authHeaders } },
      ),
    );

    const approvedBody = `Draft that will be approved for ${approvedItemTitle}`;
    await emitNotificationSignal({
      apiClient,
      authHeaders: owner.authHeaders,
      projectId: parseUuidV7(project.id),
      workItemId: parseUuidV7(approvedWorkItem.id),
      items: [
        {
          kind: "status_update",
          body: approvedBody,
          suggestedChannels: ["work_item_platform_comment"],
        },
      ],
    });
    const approvedDraft = await findPendingDraftByBody(
      apiClient,
      owner.authHeaders,
      parseUuidV7(approvedWorkItem.id),
      approvedBody,
    );

    const beforeApproval = await listByTitle(approvedItemTitle, true);
    expect(beforeApproval.items.map((item) => item.title)).toEqual([
      approvedItemTitle,
    ]);

    globalThis.fetch = makeCommentDraftFetchImpl({
      owner: "acme-org",
      repo: "awaiting-approval",
      issueNumber: 2,
    });

    await unwrapAsync(
      apiClient.api["work-item-comment-drafts"]({
        notificationId: approvedDraft.notification.id,
      }).approve.post(
        { body: "Approved body" },
        { headers: { ...owner.authHeaders } },
      ),
    );

    const afterApprovalFiltered = await listByTitle(approvedItemTitle, true);
    expect(afterApprovalFiltered.items).toHaveLength(0);

    const afterApprovalUnfiltered = await listByTitle(approvedItemTitle);
    expect(afterApprovalUnfiltered.items[0]?.awaitingApprovalCount).toBe(0);

    const comments = await unwrapAsync(
      apiClient.api["work-item-comments"].get({
        query: { workItemId: parseWorkItemId(approvedWorkItem.id) },
        headers: { ...owner.authHeaders },
      }),
    );
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe("Approved body");
  });
});

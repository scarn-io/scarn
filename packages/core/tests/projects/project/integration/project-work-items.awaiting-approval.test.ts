import { describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { createAppContext } from "@/lib/di";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createScarnTreaty } from "tests/treaty";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import {
  emitNotificationSignal,
  findPendingDraftByBody,
} from "tests/notifications/user-notification/integration/emit-notification-signal-support";
import { createTestUserAndSession } from "./auth-test-utils";
import {
  createListingProject,
  seedWorkItems,
  type ListingProject,
} from "./work-item-listing-test-support";

/**
 * `awaitingApproval` for `GET /projects/:projectId/work-items` — Phase 1 of
 * `docs/plans/awaiting-approval-filter.md`. The frontend does not send this
 * param yet; this suite exercises the backend directly.
 *
 * Covers everything that never needs a real GitHub post attempt: the
 * predicate itself, the count, the no-fan-out invariant, and the
 * `work-item-platform-comment:write` server-side gate. That gate was
 * originally `comments:read` (decisions 13/14 of
 * `docs/plans/awaiting-approval-filter.md`), but that let a caller see the
 * "Awaiting approval" badge on the list without being able to see the draft
 * it refers to on the detail page (whose card is gated on
 * `work-item-platform-comment:write`) — the built-in `read` role holds
 * `comments:read` without `work-item-platform-comment:write`
 * (`project-role.ts`), so this was not a corner case. Both surfaces
 * are now gated on the same, stricter permission. The `failed`/approved
 * status cases live in `project-work-items.awaiting-approval-github
 * .test.ts` instead — splitting out to keep this file under the repo's
 * `max-lines` limit, the same precedent
 * `ingest-github-issue-relationships.blocking.test.ts` and its siblings
 * follow.
 *
 * Every case below gets its *own* fresh project (rather than
 * `project-work-items.latest-execution-status.test.ts`'s shared-project-
 * plus-title-prefix precedent): `emitNotificationSignal` claims a step
 * execution via `batchSize: 1` scoped only to the project, so two concurrent
 * tests sharing one project could each claim the other's task.
 */
describe("project work items awaiting approval filter", () => {
  const NOW = new Date("2026-04-26T12:00:00.000Z");
  const app = createApp(
    createAppContext({ timeProvider: fixedTimeProvider(NOW) }),
  );
  const apiClient = createScarnTreaty(app);

  describe("filter predicate and count", () => {
    const listByTitlePrefix = async (
      project: ListingProject,
      titlePrefix: string,
      awaitingApproval?: boolean,
    ) =>
      await unwrapAsync(
        apiClient.api
          .projects({ projectId: project.projectId })
          ["work-items"].get({
            query: {
              page: 1,
              pageSize: 25,
              q: titlePrefix,
              ...(awaitingApproval !== undefined
                ? { awaitingApproval: String(awaitingApproval) }
                : {}),
            },
            headers: { ...project.authHeaders },
          }),
      );

    concurrentTest(
      "an item with a pending draft matches the filter",
      async () => {
        const project = await createListingProject(
          apiClient,
          "awaiting-pending",
        );
        const titlePrefix = `awaiting-pending-${crypto.randomUUID()}`;
        const [workItem] = await seedWorkItems(apiClient, project, [
          { title: titlePrefix },
        ]);
        if (!workItem) {
          throw new Error("Expected the seeded work item to exist");
        }

        await emitNotificationSignal({
          apiClient,
          authHeaders: project.authHeaders,
          projectId: project.projectId,
          workItemId: parseUuidV7(workItem.id),
          items: [
            {
              kind: "status_update",
              body: `Pending draft for ${titlePrefix}`,
              suggestedChannels: ["work_item_platform_comment"],
            },
          ],
        });

        const filtered = await listByTitlePrefix(project, titlePrefix, true);
        expect(filtered.items.map((item) => item.title)).toEqual([titlePrefix]);
        expect(filtered.items[0]?.awaitingApprovalCount).toBe(1);
      },
    );

    concurrentTest(
      "a suppressed (rejected) draft does not match the filter, and the count drops back to 0",
      async () => {
        const project = await createListingProject(
          apiClient,
          "awaiting-suppressed",
        );
        const titlePrefix = `awaiting-suppressed-${crypto.randomUUID()}`;
        const [workItem] = await seedWorkItems(apiClient, project, [
          { title: titlePrefix },
        ]);
        if (!workItem) {
          throw new Error("Expected the seeded work item to exist");
        }

        const body = `Rejected draft for ${titlePrefix}`;
        await emitNotificationSignal({
          apiClient,
          authHeaders: project.authHeaders,
          projectId: project.projectId,
          workItemId: parseUuidV7(workItem.id),
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
          project.authHeaders,
          parseUuidV7(workItem.id),
          body,
        );
        await unwrapAsync(
          apiClient.api["work-item-comment-drafts"]({
            notificationId: draft.notification.id,
          }).reject.post(undefined, { headers: { ...project.authHeaders } }),
        );

        const filtered = await listByTitlePrefix(project, titlePrefix, true);
        expect(filtered.items).toHaveLength(0);

        const unfiltered = await listByTitlePrefix(project, titlePrefix);
        expect(unfiltered.items[0]?.awaitingApprovalCount).toBe(0);
      },
    );

    concurrentTest(
      "an in_app-only delivery does not match the filter (wrong channel)",
      async () => {
        const project = await createListingProject(
          apiClient,
          "awaiting-in-app-only",
        );
        const titlePrefix = `awaiting-in-app-only-${crypto.randomUUID()}`;
        const [workItem] = await seedWorkItems(apiClient, project, [
          { title: titlePrefix },
        ]);
        if (!workItem) {
          throw new Error("Expected the seeded work item to exist");
        }

        await emitNotificationSignal({
          apiClient,
          authHeaders: project.authHeaders,
          projectId: project.projectId,
          workItemId: parseUuidV7(workItem.id),
          items: [
            {
              kind: "feedback_request",
              body: `In-app only for ${titlePrefix}`,
              suggestedChannels: ["in_app"],
            },
          ],
        });

        const filtered = await listByTitlePrefix(project, titlePrefix, true);
        expect(filtered.items).toHaveLength(0);

        const unfiltered = await listByTitlePrefix(project, titlePrefix);
        expect(unfiltered.items[0]?.awaitingApprovalCount).toBe(0);
      },
    );

    concurrentTest(
      "awaitingApprovalCount is 0, not null, for an item with no drafts at all",
      async () => {
        const project = await createListingProject(apiClient, "awaiting-none");
        const titlePrefix = `awaiting-none-${crypto.randomUUID()}`;
        await seedWorkItems(apiClient, project, [{ title: titlePrefix }]);

        const page = await listByTitlePrefix(project, titlePrefix);
        expect(page.items.map((item) => item.awaitingApprovalCount)).toEqual([
          0,
        ]);
      },
    );

    concurrentTest(
      "three drafts on one item report a count of 3 and do not inflate the page total",
      async () => {
        const project = await createListingProject(
          apiClient,
          "awaiting-no-fanout",
        );
        const titlePrefix = `awaiting-no-fanout-${crypto.randomUUID()}`;
        const [workItem] = await seedWorkItems(apiClient, project, [
          { title: titlePrefix },
        ]);
        if (!workItem) {
          throw new Error("Expected the seeded work item to exist");
        }

        await emitNotificationSignal({
          apiClient,
          authHeaders: project.authHeaders,
          projectId: project.projectId,
          workItemId: parseUuidV7(workItem.id),
          items: [
            {
              kind: "status_update",
              body: `Draft 1 for ${titlePrefix}`,
              suggestedChannels: ["work_item_platform_comment"],
            },
            {
              kind: "status_update",
              body: `Draft 2 for ${titlePrefix}`,
              suggestedChannels: ["work_item_platform_comment"],
            },
            {
              kind: "status_update",
              body: `Draft 3 for ${titlePrefix}`,
              suggestedChannels: ["work_item_platform_comment"],
            },
          ],
        });

        const page = await listByTitlePrefix(project, titlePrefix);
        expect(page.items).toHaveLength(1);
        expect(page.pagination.total).toBe(1);
        expect(page.items[0]?.awaitingApprovalCount).toBe(3);
      },
    );
  });

  describe("work-item-platform-comment:write gate", () => {
    concurrentTest(
      "a caller with work-items:read but not work-item-platform-comment:write: awaitingApproval has no filtering effect, and the count is always 0 even with a pending draft — the request still returns 200",
      async () => {
        const owner = await createTestUserAndSession({
          email: `awaiting-approval-gate-owner-${crypto.randomUUID()}@example.com`,
        });
        const member = await createTestUserAndSession({
          email: `awaiting-approval-gate-member-${crypto.randomUUID()}@example.com`,
        });

        const project = await unwrapAsync(
          apiClient.api.projects.post(
            {
              name: "Awaiting Approval Gate Project",
              description:
                "Project for the work-item-platform-comment:write gate suite",
              gitUrl: "https://github.com/example/test-project.git",
            },
            { headers: { ...owner.authHeaders } },
          ),
        );

        // Deliberately insufficient — the `read` role excludes
        // work-item-platform-comment:write.
        await unwrapAsync(
          apiClient.api
            .projects({ projectId: project.id })
            .members({ userId: member.userId })
            .role.put({ role: "read" }, { headers: { ...owner.authHeaders } }),
        );

        const titlePrefix = `awaiting-gate-${crypto.randomUUID()}`;
        const workItem = await unwrapAsync(
          apiClient.api["work-items"].post(
            {
              projectId: project.id,
              platform: "github",
              platformId: null,
              platformKey: `acme-org/gate#${crypto.randomUUID()}`,
              url: null,
              title: titlePrefix,
              description: "Repro steps",
              sourceCreatedAt: null,
              sourceUpdatedAt: null,
              fields: { repository: "acme-org/gate", number: 1 },
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
              body: `Gate draft for ${titlePrefix}`,
              suggestedChannels: ["work_item_platform_comment"],
            },
          ],
        });

        const { data, error } = await apiClient.api
          .projects({ projectId: project.id })
          ["work-items"].get({
            query: {
              page: 1,
              pageSize: 25,
              q: titlePrefix,
              awaitingApproval: "true",
            },
            headers: { ...member.authHeaders },
          });

        expect(error).toBeFalsy();
        expect(data?.items.map((item) => item.title)).toEqual([titlePrefix]);
        expect(data?.items[0]?.awaitingApprovalCount).toBe(0);
      },
    );

    concurrentTest(
      "a caller with comments:read but not work-item-platform-comment:write (e.g. the read role) also gets a suppressed count — this is the fixed gap: the badge must not outrun what the detail page's draft card will show",
      async () => {
        const owner = await createTestUserAndSession({
          email: `awaiting-approval-gate-owner-${crypto.randomUUID()}@example.com`,
        });
        const member = await createTestUserAndSession({
          email: `awaiting-approval-gate-member-${crypto.randomUUID()}@example.com`,
        });

        const project = await unwrapAsync(
          apiClient.api.projects.post(
            {
              name: "Awaiting Approval Comments-Read-Only Project",
              description:
                "Project for the comments:read-without-write regression case",
              gitUrl: "https://github.com/example/test-project.git",
            },
            { headers: { ...owner.authHeaders } },
          ),
        );

        // Holds comments:read (enough to have surfaced the badge under the
        // old gate) but not work-item-platform-comment:write — the built-in
        // `read` role (`project-role.ts`).
        await unwrapAsync(
          apiClient.api
            .projects({ projectId: project.id })
            .members({ userId: member.userId })
            .role.put({ role: "read" }, { headers: { ...owner.authHeaders } }),
        );

        const titlePrefix = `awaiting-gate-comments-read-${crypto.randomUUID()}`;
        const workItem = await unwrapAsync(
          apiClient.api["work-items"].post(
            {
              projectId: project.id,
              platform: "github",
              platformId: null,
              platformKey: `acme-org/gate-comments-read#${crypto.randomUUID()}`,
              url: null,
              title: titlePrefix,
              description: "Repro steps",
              sourceCreatedAt: null,
              sourceUpdatedAt: null,
              fields: { repository: "acme-org/gate-comments-read", number: 1 },
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
              body: `Gate draft for ${titlePrefix}`,
              suggestedChannels: ["work_item_platform_comment"],
            },
          ],
        });

        const { data, error } = await apiClient.api
          .projects({ projectId: project.id })
          ["work-items"].get({
            query: {
              page: 1,
              pageSize: 25,
              q: titlePrefix,
              awaitingApproval: "true",
            },
            headers: { ...member.authHeaders },
          });

        expect(error).toBeFalsy();
        expect(data?.items.map((item) => item.title)).toEqual([titlePrefix]);
        expect(data?.items[0]?.awaitingApprovalCount).toBe(0);
      },
    );
  });
});

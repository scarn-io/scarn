import { describe, expect, test } from "bun:test";
import { unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import {
  createRelationshipsTestHarness,
  makeRelationshipsFetchImpl,
  RECONCILE_SECRET,
  useGithubRelationshipsTestEnv,
} from "./run-project-integration-sync-relationships-test-support";

/**
 * End-to-end coverage of Phase 4's wiring: `POST
 * /projects/:projectId/integrations/:integrationId/sync`'s GitHub branch now
 * runs `ingestGitHubIssueRelationships` immediately after `ingestGitHubIssues`
 * against a real (testcontainers) database, exercising the scenarios from
 * `ingest-github-issue-relationships.*.test.ts` (3d) through the actual
 * API-facing sync flow rather than in isolation — plus a scheduled
 * (`SystemAuthorizationService`) run through
 * `POST /internal/integrations/reconcile`.
 *
 * The staggered-sync pending-refs regression lives in the sibling
 * `.pending-refs.test.ts` file (kept separate to stay under the repo's
 * `max-lines` limit).
 *
 * Every test here reassigns `globalThis.fetch` (via
 * `createRelationshipsTestHarness`'s shared `app`/`apiClient`, since the real
 * HTTP sync route has no `fetchImpl` override) — shared, process-global
 * mutable state — so this file uses `test.serial` rather than
 * `test.concurrent` to avoid one test's mock clobbering another's mid-flight.
 */
describe("GitHub sync relationship ingestion (parent links + blocking edges)", () => {
  useGithubRelationshipsTestEnv();
  const {
    app,
    apiClient,
    createProjectWithGitHubIntegration,
    runSync,
    loadSyncedWorkItem,
  } = createRelationshipsTestHarness();

  test.serial(
    "applies a parent link, creates a blocking edge, and skips an unresolvable parent reference — all from one sync run",
    async () => {
      const owner = await createTestUserAndSession({
        email: `github-relationships-happy-${crypto.randomUUID()}@example.com`,
      });
      const repoFullName = "acme/relationships-happy";
      const { project, integrationId } =
        await createProjectWithGitHubIntegration(
          owner,
          "GitHub Relationships Happy Path",
          repoFullName,
        );

      globalThis.fetch = makeRelationshipsFetchImpl({
        repoFullName,
        issues: [
          { number: 1 },
          {
            number: 2,
            parentRef: {
              owner: "acme",
              repo: "relationships-happy",
              number: 1,
            },
          },
          { number: 3 },
          {
            // References a repo/issue never synced anywhere in this project —
            // must be silently skipped (Decision 6), never thrown.
            number: 4,
            parentRef: { owner: "acme", repo: "out-of-scope", number: 99 },
          },
        ],
        blockedByByNumber: {
          1: [{ owner: "acme", repo: "relationships-happy", number: 3 }],
        },
      });

      const result = await runSync(
        project.id,
        integrationId,
        owner.authHeaders,
      );

      expect(result.totalUpserted).toBe(4);
      expect(result.parentLinksApplied).toBe(1);
      expect(result.parentLinksSkipped).toBe(1);
      expect(result.blocksCreated).toBe(1);
      expect(result.blocksSkipped).toBe(0);

      const parentItem = await loadSyncedWorkItem(project.id, repoFullName, 1);
      const childItem = await loadSyncedWorkItem(project.id, repoFullName, 2);
      const blockerItem = await loadSyncedWorkItem(project.id, repoFullName, 3);

      expect(childItem.parentWorkItemId).toBe(parentItem.id);

      const blocks = await unwrapAsync(
        apiClient.api["work-item-blocks"].get({
          query: { workItemId: parseWorkItemId(parentItem.id) },
          headers: { ...owner.authHeaders },
        }),
      );
      expect(blocks.blockedBy).toHaveLength(1);
      expect(blocks.blockedBy[0]?.blockingWorkItemId).toBe(
        parseUuidV7(blockerItem.id),
      );
    },
  );

  test.serial(
    "leaves a manually-set parent link alone on a later sync (fill-in-if-unset)",
    async () => {
      const owner = await createTestUserAndSession({
        email: `github-relationships-fill-in-unset-${crypto.randomUUID()}@example.com`,
      });
      const repoFullName = "acme/relationships-fill-in-unset";
      const { project, integrationId } =
        await createProjectWithGitHubIntegration(
          owner,
          "GitHub Relationships Fill-in-if-unset",
          repoFullName,
        );

      // First sync: no relationship data yet, just the two issues.
      globalThis.fetch = makeRelationshipsFetchImpl({
        repoFullName,
        issues: [{ number: 1 }, { number: 2 }],
      });
      const firstResult = await runSync(
        project.id,
        integrationId,
        owner.authHeaders,
      );
      expect(firstResult.parentLinksApplied).toBe(0);
      expect(firstResult.parentLinksSkipped).toBe(0);

      const manualParent = await unwrapAsync(
        apiClient.api["work-items"].post(
          {
            projectId: project.id,
            platform: "scarn",
            platformId: null,
            platformKey: `manual-${crypto.randomUUID()}`,
            url: null,
            title: "Manually created parent",
            description: "Set as issue #2's parent before a GitHub re-sync",
            sourceCreatedAt: null,
            sourceUpdatedAt: null,
            fields: null,
          },
          { headers: { ...owner.authHeaders } },
        ),
      );

      const childItemBefore = await loadSyncedWorkItem(
        project.id,
        repoFullName,
        2,
      );
      await unwrapAsync(
        apiClient.api["work-items"]({
          workItemId: childItemBefore.id,
        }).parent.patch(
          { parentWorkItemId: parseWorkItemId(manualParent.id) },
          { headers: { ...owner.authHeaders } },
        ),
      );

      // Second sync: GitHub now reports issue #1 as issue #2's parent — must
      // be skipped, since #2 already has a (manually-set) parent.
      globalThis.fetch = makeRelationshipsFetchImpl({
        repoFullName,
        issues: [
          { number: 1 },
          {
            number: 2,
            parentRef: {
              owner: "acme",
              repo: "relationships-fill-in-unset",
              number: 1,
            },
          },
        ],
      });
      const secondResult = await runSync(
        project.id,
        integrationId,
        owner.authHeaders,
      );

      expect(secondResult.parentLinksApplied).toBe(0);
      expect(secondResult.parentLinksSkipped).toBe(1);

      const childItemAfter = await loadSyncedWorkItem(
        project.id,
        repoFullName,
        2,
      );
      expect(childItemAfter.parentWorkItemId).toBe(
        parseWorkItemId(manualParent.id),
      );
    },
  );

  test.serial(
    "does not duplicate a blocking edge already created by a prior sync",
    async () => {
      const owner = await createTestUserAndSession({
        email: `github-relationships-dedup-${crypto.randomUUID()}@example.com`,
      });
      const repoFullName = "acme/relationships-dedup";
      const { project, integrationId } =
        await createProjectWithGitHubIntegration(
          owner,
          "GitHub Relationships Block Dedup",
          repoFullName,
        );

      const fetchOpts = {
        repoFullName,
        issues: [{ number: 1 }, { number: 2 }],
        blockedByByNumber: {
          1: [{ owner: "acme", repo: "relationships-dedup", number: 2 }],
        },
      };

      globalThis.fetch = makeRelationshipsFetchImpl(fetchOpts);
      const firstResult = await runSync(
        project.id,
        integrationId,
        owner.authHeaders,
      );
      expect(firstResult.blocksCreated).toBe(1);
      expect(firstResult.blocksSkipped).toBe(0);

      // GitHub reports the exact same `blockedBy` edge again on a routine
      // re-sync — must be skipped, not re-created (Decision 8).
      globalThis.fetch = makeRelationshipsFetchImpl(fetchOpts);
      const secondResult = await runSync(
        project.id,
        integrationId,
        owner.authHeaders,
      );
      expect(secondResult.blocksCreated).toBe(0);
      expect(secondResult.blocksSkipped).toBe(1);

      const blockedItem = await loadSyncedWorkItem(project.id, repoFullName, 1);
      const blocks = await unwrapAsync(
        apiClient.api["work-item-blocks"].get({
          query: { workItemId: parseWorkItemId(blockedItem.id) },
          headers: { ...owner.authHeaders },
        }),
      );
      expect(blocks.blockedBy).toHaveLength(1);
    },
  );

  test.serial(
    "a scheduled reconciliation run (SystemAuthorizationService) applies relationships under the work-items:write allowlist entry",
    async () => {
      const owner = await createTestUserAndSession({
        email: `github-relationships-scheduled-${crypto.randomUUID()}@example.com`,
      });
      const repoFullName = "acme/relationships-scheduled";
      const { project } = await createProjectWithGitHubIntegration(
        owner,
        "GitHub Relationships Scheduled Run",
        repoFullName,
      );

      globalThis.fetch = makeRelationshipsFetchImpl({
        repoFullName,
        issues: [
          { number: 1 },
          {
            number: 2,
            parentRef: {
              owner: "acme",
              repo: "relationships-scheduled",
              number: 1,
            },
          },
        ],
      });

      const response = await app.handle(
        new Request("http://localhost/api/internal/integrations/reconcile", {
          method: "POST",
          headers: { authorization: `Bearer ${RECONCILE_SECRET}` },
        }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        integrationsAttempted: number;
        integrationsSucceeded: number;
      };
      expect(body.integrationsAttempted).toBeGreaterThanOrEqual(1);
      // Not `integrationsFailed === 0`: the sweep is global, so integrations
      // other test files (on other `--parallel` workers) have active right now
      // are swept too and fail against this test's single-repo fetch mock.
      expect(body.integrationsSucceeded).toBeGreaterThanOrEqual(1);

      const parentItem = await loadSyncedWorkItem(project.id, repoFullName, 1);
      const childItem = await loadSyncedWorkItem(project.id, repoFullName, 2);
      expect(childItem.parentWorkItemId).toBe(parentItem.id);
    },
  );
});

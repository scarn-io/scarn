import { describe, expect, test } from "bun:test";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import {
  createRelationshipsTestHarness,
  makeRelationshipsFetchImpl,
  useGithubRelationshipsTestEnv,
} from "./run-project-integration-sync-relationships-test-support";

/**
 * Permanent regression test for the staggered-sync gap diagnosed in
 * `docs/github-relationship-pending-references-plan.md` (the scratch repro
 * referenced there was never committed). End-to-end through the real
 * `POST /projects/:projectId/integrations/:integrationId/sync` route against
 * a real (testcontainers) database, proving the fix works via the
 * `github_relationship_pending_refs` table rather than by luck: the children
 * are only ever present in sync 1's fetched issue payload — sync 2's and
 * sync 3's mocks list only the parent, then nothing at all.
 *
 * Split out of `run-project-integration-sync.relationships.test.ts` to stay
 * under the repo's `max-lines` limit.
 *
 * Uses `test.serial` for the same reason as its sibling file: it reassigns
 * `globalThis.fetch` (repeatedly, across three simulated sync runs) via the
 * shared `createRelationshipsTestHarness`, which is shared, process-global
 * mutable state.
 */
describe("GitHub sync relationship ingestion — staggered-sync pending refs", () => {
  useGithubRelationshipsTestEnv();
  const { createProjectWithGitHubIntegration, runSync, loadSyncedWorkItem } =
    createRelationshipsTestHarness();

  test.serial("resolves a parent link via the pending-refs table once the parent is finally synced, without ever re-fetching the children", async () => {
    const owner = await createTestUserAndSession({
      email: `github-relationships-staggered-${crypto.randomUUID()}@example.com`,
    });
    const repoFullName = "acme/relationships-staggered";
    const { project, integrationId } = await createProjectWithGitHubIntegration(
      owner,
      "GitHub Relationships Staggered Sync",
      repoFullName,
    );

    // Sync 1: only the children are fetched (recently active). Their shared
    // parent (issue #1) is outside this run's `since` window and hasn't been
    // synced/upserted anywhere yet — both parent links must be skipped and
    // persisted as pending rows.
    globalThis.fetch = makeRelationshipsFetchImpl({
      repoFullName,
      issues: [
        {
          number: 2,
          parentRef: {
            owner: "acme",
            repo: "relationships-staggered",
            number: 1,
          },
        },
        {
          number: 3,
          parentRef: {
            owner: "acme",
            repo: "relationships-staggered",
            number: 1,
          },
        },
      ],
    });
    const firstResult = await runSync(
      project.id,
      integrationId,
      owner.authHeaders,
    );
    expect(firstResult.parentLinksApplied).toBe(0);
    expect(firstResult.parentLinksSkipped).toBe(2);

    const child2AfterFirstSync = await loadSyncedWorkItem(
      project.id,
      repoFullName,
      2,
    );
    const child3AfterFirstSync = await loadSyncedWorkItem(
      project.id,
      repoFullName,
      3,
    );
    expect(child2AfterFirstSync.parentWorkItemId).toBeNull();
    expect(child3AfterFirstSync.parentWorkItemId).toBeNull();

    // Sync 2: only the parent is fetched this time — GitHub's `since` filter
    // excludes the children because they haven't changed since sync 1.
    globalThis.fetch = makeRelationshipsFetchImpl({
      repoFullName,
      issues: [{ number: 1 }],
    });
    await runSync(project.id, integrationId, owner.authHeaders);

    // Sync 3: no GitHub changes at all — not even the parent is fetched.
    // Reproduces the bug's terminal state (the children never change again
    // on GitHub) while proving the fix doesn't depend on any further GitHub
    // activity to complete.
    globalThis.fetch = makeRelationshipsFetchImpl({
      repoFullName,
      issues: [],
    });
    await runSync(project.id, integrationId, owner.authHeaders);

    const parentItem = await loadSyncedWorkItem(project.id, repoFullName, 1);
    const child2 = await loadSyncedWorkItem(project.id, repoFullName, 2);
    const child3 = await loadSyncedWorkItem(project.id, repoFullName, 3);

    expect(child2.parentWorkItemId).toBe(parentItem.id);
    expect(child3.parentWorkItemId).toBe(parentItem.id);
  });
});

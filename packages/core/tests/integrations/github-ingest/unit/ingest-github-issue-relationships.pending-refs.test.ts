import { describe, expect, test } from "bun:test";
import { ingestGitHubIssueRelationships } from "@/integrations/github-ingest/application/ingest-github-issue-relationships";
import type { GithubRelationshipPendingRef } from "@/integrations/github-ingest/application/github-relationship-pending-ref-repo";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { fixedTimeProvider } from "tests/utils";
import {
  makeGithubRelationshipPendingRefRepo,
  makeGraphQLFetchImpl,
  makeIssue,
  makeUserAuthz,
  makeWorkItem,
  makeWorkItemBlockRepo,
  makeWorkItemRepo,
  noBlockedBy,
  noopWorkItemEvents,
  now,
  projectId,
} from "./ingest-github-issue-relationships-test-support";

/**
 * Pending-reference reconciliation scenarios for
 * `ingestGitHubIssueRelationships` — see
 * `docs/github-relationship-pending-references-plan.md`. Split out from
 * `.parent.test.ts`/`.blocking.test.ts` to keep each file under the repo's
 * `max-lines` limit.
 */
describe("ingestGitHubIssueRelationships (pending-ref reconciliation)", () => {
  test("resolves a pending parent row once its target is synced in a later run, without the child being re-fetched", async () => {
    const childIssue = makeIssue({ number: 2 });
    const childWorkItem = makeWorkItem({ number: 2 });

    const { repo: workItemRepo, store } = makeWorkItemRepo([childWorkItem]);
    const { repo: workItemBlockRepo } = makeWorkItemBlockRepo();
    const { repo: pendingRefRepo, rows } =
      makeGithubRelationshipPendingRefRepo();

    const runOne = await ingestGitHubIssueRelationships(
      {
        projectId,
        accessToken: "token",
        issuesByRepo: [{ fullName: "acme/repo", issues: [childIssue] }],
        fetchImpl: makeGraphQLFetchImpl(noBlockedBy(1), [
          { owner: "acme", repo: "repo", number: 1 },
        ]),
      },
      {
        workItemRepo,
        workItemBlockRepo,
        githubRelationshipPendingRefRepo: pendingRefRepo,
        userAuthz: makeUserAuthz(),
        workItemEvents: noopWorkItemEvents,
        timeProvider: fixedTimeProvider(now),
      },
    );

    expect(runOne.parentLinksApplied).toBe(0);
    expect(runOne.parentLinksSkipped).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workItemId: childWorkItem.id,
      kind: "parent",
      targetPlatformKey: "acme/repo#1",
    });

    // The parent finally gets synced by a later Phase A run — the child
    // itself is never touched on GitHub again, so it isn't re-fetched.
    const parentWorkItem = makeWorkItem({ number: 1 });
    store.set(parentWorkItem.id, parentWorkItem);

    const runTwo = await ingestGitHubIssueRelationships(
      {
        projectId,
        accessToken: "token",
        issuesByRepo: [],
        fetchImpl: makeGraphQLFetchImpl([]),
      },
      {
        workItemRepo,
        workItemBlockRepo,
        githubRelationshipPendingRefRepo: pendingRefRepo,
        userAuthz: makeUserAuthz(),
        workItemEvents: noopWorkItemEvents,
        timeProvider: fixedTimeProvider(now),
      },
    );

    expect(runTwo.parentLinksApplied).toBe(1);
    expect(runTwo.parentLinksSkipped).toBe(0);
    expect(store.get(childWorkItem.id)?.parentWorkItemId).toBe(
      parentWorkItem.id,
    );
    expect(rows).toHaveLength(0);
  });

  test("resolves a pending blocked_by row once its target is synced in a later run", async () => {
    const blockedIssue = makeIssue({ number: 1 });
    const blockedWorkItem = makeWorkItem({ number: 1 });

    const { repo: workItemRepo, store } = makeWorkItemRepo([blockedWorkItem]);
    const { repo: workItemBlockRepo, created } = makeWorkItemBlockRepo();
    const { repo: pendingRefRepo, rows } =
      makeGithubRelationshipPendingRefRepo();

    const runOne = await ingestGitHubIssueRelationships(
      {
        projectId,
        accessToken: "token",
        issuesByRepo: [{ fullName: "acme/repo", issues: [blockedIssue] }],
        fetchImpl: makeGraphQLFetchImpl([
          [{ owner: "acme", repo: "repo", number: 2 }],
        ]),
      },
      {
        workItemRepo,
        workItemBlockRepo,
        githubRelationshipPendingRefRepo: pendingRefRepo,
        userAuthz: makeUserAuthz(),
        workItemEvents: noopWorkItemEvents,
        timeProvider: fixedTimeProvider(now),
      },
    );

    expect(runOne.blocksCreated).toBe(0);
    expect(runOne.blocksSkipped).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workItemId: blockedWorkItem.id,
      kind: "blocked_by",
      targetPlatformKey: "acme/repo#2",
    });

    const blockingWorkItem = makeWorkItem({ number: 2 });
    store.set(blockingWorkItem.id, blockingWorkItem);

    const runTwo = await ingestGitHubIssueRelationships(
      {
        projectId,
        accessToken: "token",
        issuesByRepo: [],
        fetchImpl: makeGraphQLFetchImpl([]),
      },
      {
        workItemRepo,
        workItemBlockRepo,
        githubRelationshipPendingRefRepo: pendingRefRepo,
        userAuthz: makeUserAuthz(),
        workItemEvents: noopWorkItemEvents,
        timeProvider: fixedTimeProvider(now),
      },
    );

    expect(runTwo.blocksCreated).toBe(1);
    expect(created).toHaveLength(1);
    expect(rows).toHaveLength(0);
  });

  test("deletes a pending parent row on a permanent validation rejection instead of retrying forever", async () => {
    const childIssue = makeIssue({ number: 2 });
    const childWorkItem = makeWorkItem({ number: 2 });

    const { repo: workItemRepo, store } = makeWorkItemRepo([childWorkItem]);
    const { repo: workItemBlockRepo } = makeWorkItemBlockRepo();
    const { repo: pendingRefRepo, rows } =
      makeGithubRelationshipPendingRefRepo();

    await ingestGitHubIssueRelationships(
      {
        projectId,
        accessToken: "token",
        issuesByRepo: [{ fullName: "acme/repo", issues: [childIssue] }],
        fetchImpl: makeGraphQLFetchImpl(noBlockedBy(1), [
          { owner: "acme", repo: "repo", number: 1 },
        ]),
      },
      {
        workItemRepo,
        workItemBlockRepo,
        githubRelationshipPendingRefRepo: pendingRefRepo,
        userAuthz: makeUserAuthz(),
        workItemEvents: noopWorkItemEvents,
        timeProvider: fixedTimeProvider(now),
      },
    );
    expect(rows).toHaveLength(1);

    // Between runs, the child is given a different parent through some other
    // path (e.g. a manual UI action), and the originally-referenced parent
    // is finally synced too.
    const parentWorkItem = makeWorkItem({ number: 1 });
    const unrelatedParent = makeWorkItem({ number: 3 });
    store.set(parentWorkItem.id, parentWorkItem);
    store.set(
      childWorkItem.id,
      childWorkItem.setParent(unrelatedParent.id, now),
    );

    const runTwo = await ingestGitHubIssueRelationships(
      {
        projectId,
        accessToken: "token",
        issuesByRepo: [],
        fetchImpl: makeGraphQLFetchImpl([]),
      },
      {
        workItemRepo,
        workItemBlockRepo,
        githubRelationshipPendingRefRepo: pendingRefRepo,
        userAuthz: makeUserAuthz(),
        workItemEvents: noopWorkItemEvents,
        timeProvider: fixedTimeProvider(now),
      },
    );

    expect(runTwo.parentLinksApplied).toBe(0);
    expect(runTwo.parentLinksSkipped).toBe(1);
    expect(store.get(childWorkItem.id)?.parentWorkItemId).toBe(
      unrelatedParent.id,
    );
    expect(rows).toHaveLength(0);
  });

  test("a genuinely cross-project pending row survives indefinitely across repeated reprocessing without erroring", async () => {
    const childWorkItem = makeWorkItem({ number: 2 });
    const { repo: workItemRepo } = makeWorkItemRepo([childWorkItem]);
    const { repo: workItemBlockRepo } = makeWorkItemBlockRepo();

    const staleRow: GithubRelationshipPendingRef = {
      id: createUuidV7(),
      projectId,
      workItemId: childWorkItem.id,
      kind: "parent",
      targetPlatformKey: "other-org/other-repo#1",
    };
    const {
      repo: pendingRefRepo,
      rows,
      upserted,
      deleted,
    } = makeGithubRelationshipPendingRefRepo([staleRow]);

    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await ingestGitHubIssueRelationships(
        {
          projectId,
          accessToken: "token",
          issuesByRepo: [],
          fetchImpl: makeGraphQLFetchImpl([]),
        },
        {
          workItemRepo,
          workItemBlockRepo,
          githubRelationshipPendingRefRepo: pendingRefRepo,
          userAuthz: makeUserAuthz(),
          workItemEvents: noopWorkItemEvents,
          timeProvider: fixedTimeProvider(now),
        },
      );
      expect(result.parentLinksApplied).toBe(0);
      expect(result.parentLinksSkipped).toBe(1);
    }

    expect(rows).toHaveLength(1);
    expect(upserted).toHaveLength(0);
    expect(deleted).toHaveLength(0);
  });

  test("a fresh candidate that resolves immediately never touches the pending table", async () => {
    const parentIssue = makeIssue({ number: 1 });
    const childIssue = makeIssue({ number: 2 });
    const parentWorkItem = makeWorkItem({ number: 1 });
    const childWorkItem = makeWorkItem({ number: 2 });

    const { repo: workItemRepo } = makeWorkItemRepo([
      parentWorkItem,
      childWorkItem,
    ]);
    const { repo: workItemBlockRepo } = makeWorkItemBlockRepo();
    const {
      repo: pendingRefRepo,
      rows,
      upserted,
      deleted,
    } = makeGithubRelationshipPendingRefRepo();

    const result = await ingestGitHubIssueRelationships(
      {
        projectId,
        accessToken: "token",
        issuesByRepo: [
          { fullName: "acme/repo", issues: [parentIssue, childIssue] },
        ],
        fetchImpl: makeGraphQLFetchImpl(noBlockedBy(2), [
          null,
          { owner: "acme", repo: "repo", number: 1 },
        ]),
      },
      {
        workItemRepo,
        workItemBlockRepo,
        githubRelationshipPendingRefRepo: pendingRefRepo,
        userAuthz: makeUserAuthz(),
        workItemEvents: noopWorkItemEvents,
        timeProvider: fixedTimeProvider(now),
      },
    );

    expect(result.parentLinksApplied).toBe(1);
    expect(rows).toHaveLength(0);
    expect(upserted).toHaveLength(0);
    expect(deleted).toHaveLength(0);
  });
});

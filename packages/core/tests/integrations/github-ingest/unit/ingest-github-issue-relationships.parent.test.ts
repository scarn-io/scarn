import { describe, expect, test } from "bun:test";
import { ingestGitHubIssueRelationships } from "@/integrations/github-ingest/application/ingest-github-issue-relationships";
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
  otherProjectId,
  projectId,
} from "./ingest-github-issue-relationships-test-support";

/**
 * Parent-pass scenarios for `ingestGitHubIssueRelationships` — see
 * `ingest-github-issue-relationships.blocking.test.ts` for the blocking-pass
 * and edge-case scenarios, split out to keep each file under the repo's
 * `max-lines` limit.
 */
describe("ingestGitHubIssueRelationships (parent pass)", () => {
  test("applies a parent link when the child has no existing parent", async () => {
    const parentIssue = makeIssue({ number: 1 });
    const childIssue = makeIssue({ number: 2 });

    const parentWorkItem = makeWorkItem({ number: 1 });
    const childWorkItem = makeWorkItem({ number: 2 });

    const { repo: workItemRepo, store } = makeWorkItemRepo([
      parentWorkItem,
      childWorkItem,
    ]);
    const { repo: workItemBlockRepo } = makeWorkItemBlockRepo();

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
        githubRelationshipPendingRefRepo:
          makeGithubRelationshipPendingRefRepo().repo,
        userAuthz: makeUserAuthz(),
        workItemEvents: noopWorkItemEvents,
        timeProvider: fixedTimeProvider(now),
      },
    );

    expect(result.parentLinksApplied).toBe(1);
    expect(result.parentLinksSkipped).toBe(0);
    expect(store.get(childWorkItem.id)?.parentWorkItemId).toBe(
      parentWorkItem.id,
    );
  });

  test("leaves an existing parent link alone (fill-in-if-unset)", async () => {
    const unrelatedParent = makeWorkItem({ number: 3 });
    const parentIssue = makeIssue({ number: 1 });
    const childIssue = makeIssue({ number: 2 });

    const parentWorkItem = makeWorkItem({ number: 1 });
    const childWorkItem = makeWorkItem({
      number: 2,
      parentWorkItemId: unrelatedParent.id,
    });

    const { repo: workItemRepo, saved } = makeWorkItemRepo([
      parentWorkItem,
      childWorkItem,
      unrelatedParent,
    ]);
    const { repo: workItemBlockRepo } = makeWorkItemBlockRepo();

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
        githubRelationshipPendingRefRepo:
          makeGithubRelationshipPendingRefRepo().repo,
        userAuthz: makeUserAuthz(),
        workItemEvents: noopWorkItemEvents,
        timeProvider: fixedTimeProvider(now),
      },
    );

    expect(result.parentLinksApplied).toBe(0);
    expect(result.parentLinksSkipped).toBe(1);
    expect(saved).toHaveLength(0);
  });

  test("skips a parent link across projects without throwing", async () => {
    const childIssue = makeIssue({ number: 2 });

    const childWorkItem = makeWorkItem({ number: 2 });
    // Same platformKey ("acme/repo#1") as the parent ref would resolve to,
    // but stored under a different project — see `makeWorkItemRepo`'s doc
    // comment for why this is reachable in the fake even though the real
    // repo scopes by `projectId`.
    const crossProjectParent = makeWorkItem({
      number: 1,
      projectId: otherProjectId,
    });

    const { repo: workItemRepo, saved } = makeWorkItemRepo([
      childWorkItem,
      crossProjectParent,
    ]);
    const { repo: workItemBlockRepo } = makeWorkItemBlockRepo();

    const result = await ingestGitHubIssueRelationships(
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
        githubRelationshipPendingRefRepo:
          makeGithubRelationshipPendingRefRepo().repo,
        userAuthz: makeUserAuthz(),
        workItemEvents: noopWorkItemEvents,
        timeProvider: fixedTimeProvider(now),
      },
    );

    expect(result.parentLinksApplied).toBe(0);
    expect(result.parentLinksSkipped).toBe(1);
    expect(saved).toHaveLength(0);
  });

  test("skips a parent link that would create a cycle", async () => {
    // A is B's parent already; GitHub now reports B as A's parent too, which
    // would create a 2-node cycle.
    const itemA = makeWorkItem({ number: 1 });
    const itemB = makeWorkItem({ number: 2, parentWorkItemId: itemA.id });

    const issueA = makeIssue({ number: 1 });
    const issueB = makeIssue({ number: 2 });

    const { repo: workItemRepo, saved } = makeWorkItemRepo([itemA, itemB]);
    const { repo: workItemBlockRepo } = makeWorkItemBlockRepo();

    const result = await ingestGitHubIssueRelationships(
      {
        projectId,
        accessToken: "token",
        issuesByRepo: [{ fullName: "acme/repo", issues: [issueA, issueB] }],
        fetchImpl: makeGraphQLFetchImpl(noBlockedBy(2), [
          { owner: "acme", repo: "repo", number: 2 },
          null,
        ]),
      },
      {
        workItemRepo,
        workItemBlockRepo,
        githubRelationshipPendingRefRepo:
          makeGithubRelationshipPendingRefRepo().repo,
        userAuthz: makeUserAuthz(),
        workItemEvents: noopWorkItemEvents,
        timeProvider: fixedTimeProvider(now),
      },
    );

    expect(result.parentLinksApplied).toBe(0);
    expect(result.parentLinksSkipped).toBe(1);
    expect(saved).toHaveLength(0);
  });

  test("returns zero counts without calling fetch when there are no issues", async () => {
    const { repo: workItemRepo } = makeWorkItemRepo([]);
    const { repo: workItemBlockRepo } = makeWorkItemBlockRepo();
    const fetchImpl = (() => {
      throw new Error("should not be called");
    }) as unknown as typeof fetch;

    const result = await ingestGitHubIssueRelationships(
      {
        projectId,
        accessToken: "token",
        issuesByRepo: [{ fullName: "acme/repo", issues: [] }],
        fetchImpl,
      },
      {
        workItemRepo,
        workItemBlockRepo,
        githubRelationshipPendingRefRepo:
          makeGithubRelationshipPendingRefRepo().repo,
        userAuthz: makeUserAuthz(),
        workItemEvents: noopWorkItemEvents,
        timeProvider: fixedTimeProvider(now),
      },
    );

    expect(result).toEqual({
      parentLinksApplied: 0,
      parentLinksSkipped: 0,
      blocksCreated: 0,
      blocksSkipped: 0,
    });
  });
});

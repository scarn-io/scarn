import { describe, expect, test } from "bun:test";
import { ingestGitHubIssueRelationships } from "@/integrations/github-ingest/application/ingest-github-issue-relationships";
import type { UserAuthorizationService } from "@/access/authorization/application/user-authorization-service";
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
 * Scoped-resolution scenarios for `ingestGitHubIssueRelationships` — see
 * `docs/plans/github-integration-sync-scaling.md`, Phase 3, Decision 7: the
 * whole resolution pass is skipped only when a run has both zero changed
 * issues (an empty `issuesByRepo`) *and* an empty pending-refs backlog for
 * the project. Split out from `.parent.test.ts`/`.blocking.test.ts`/
 * `.pending-refs.test.ts` to keep each file under the repo's `max-lines`
 * limit.
 */
describe("ingestGitHubIssueRelationships (Phase 3 skip-when-unchanged)", () => {
  const spyUserAuthz = (): {
    userAuthz: UserAuthorizationService;
    callCount: () => number;
  } => {
    const base = makeUserAuthz();
    let calls = 0;
    const userAuthz: UserAuthorizationService = {
      ...base,
      requireProjectPermission: (input) => {
        calls += 1;
        return base.requireProjectPermission(input);
      },
    };
    return { userAuthz, callCount: () => calls };
  };

  const countingFetch = (
    inner: typeof fetch,
  ): { fetchImpl: typeof fetch; calls: () => number } => {
    let calls = 0;
    const fetchImpl = ((...args: Parameters<typeof fetch>) => {
      calls += 1;
      return inner(...args);
    }) as typeof fetch;
    return { fetchImpl, calls: () => calls };
  };

  test("skips the whole resolution pass when there are no changed issues and no pending refs", async () => {
    const { repo: workItemRepo } = makeWorkItemRepo([]);
    const { repo: workItemBlockRepo } = makeWorkItemBlockRepo();
    const {
      repo: pendingRefRepo,
      rows,
      upserted,
      deleted,
    } = makeGithubRelationshipPendingRefRepo();
    const authzSpy = spyUserAuthz();
    const { fetchImpl, calls: fetchCalls } = countingFetch((() => {
      throw new Error("Unexpected GitHub relationship-API call");
    }) as unknown as typeof fetch);

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
        githubRelationshipPendingRefRepo: pendingRefRepo,
        userAuthz: authzSpy.userAuthz,
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
    expect(fetchCalls()).toBe(0);
    expect(authzSpy.callCount()).toBe(0);
    expect(rows).toHaveLength(0);
    expect(upserted).toHaveLength(0);
    expect(deleted).toHaveLength(0);
  });

  test("still runs the resolution pass when pending refs are present even with zero changed issues", async () => {
    const parentWorkItem = makeWorkItem({ number: 1 });
    const childWorkItem = makeWorkItem({ number: 2 });
    const { repo: workItemRepo, store } = makeWorkItemRepo([
      parentWorkItem,
      childWorkItem,
    ]);
    const { repo: workItemBlockRepo } = makeWorkItemBlockRepo();

    const pendingRow: GithubRelationshipPendingRef = {
      id: createUuidV7(),
      projectId,
      workItemId: childWorkItem.id,
      kind: "parent",
      targetPlatformKey: "acme/repo#1",
    };
    const { repo: pendingRefRepo, rows } = makeGithubRelationshipPendingRefRepo(
      [pendingRow],
    );
    const authzSpy = spyUserAuthz();
    const { fetchImpl, calls: fetchCalls } = countingFetch(
      makeGraphQLFetchImpl([]),
    );

    const result = await ingestGitHubIssueRelationships(
      {
        projectId,
        accessToken: "token",
        issuesByRepo: [],
        fetchImpl,
      },
      {
        workItemRepo,
        workItemBlockRepo,
        githubRelationshipPendingRefRepo: pendingRefRepo,
        userAuthz: authzSpy.userAuthz,
        workItemEvents: noopWorkItemEvents,
        timeProvider: fixedTimeProvider(now),
      },
    );

    expect(authzSpy.callCount()).toBeGreaterThan(0);
    expect(result.parentLinksApplied).toBe(1);
    expect(store.get(childWorkItem.id)?.parentWorkItemId).toBe(
      parentWorkItem.id,
    );
    // The pending row resolved this run — proves it was reprocessed, not
    // skipped, even though `issuesByRepo` carried zero issues.
    expect(rows).toHaveLength(0);
    // `fetchIssueRelationshipsBatch` is only ever invoked with refs built
    // from *this run's* fetched issues; a zero-issue run legitimately never
    // calls it even when the pass runs — asserted here to document that
    // "still runs" is about the pending-refs reconciliation loop, not about
    // this call.
    expect(fetchCalls()).toBe(0);
  });

  test("still runs the resolution pass when changed issues are present even with an empty backlog", async () => {
    const parentIssue = makeIssue({ number: 1 });
    const childIssue = makeIssue({ number: 2 });
    const parentWorkItem = makeWorkItem({ number: 1 });
    const childWorkItem = makeWorkItem({ number: 2 });

    const { repo: workItemRepo, store } = makeWorkItemRepo([
      parentWorkItem,
      childWorkItem,
    ]);
    const { repo: workItemBlockRepo } = makeWorkItemBlockRepo();
    const { repo: pendingRefRepo, rows } =
      makeGithubRelationshipPendingRefRepo();
    const authzSpy = spyUserAuthz();
    const { fetchImpl, calls: fetchCalls } = countingFetch(
      makeGraphQLFetchImpl(noBlockedBy(2), [
        null,
        { owner: "acme", repo: "repo", number: 1 },
      ]),
    );

    const result = await ingestGitHubIssueRelationships(
      {
        projectId,
        accessToken: "token",
        issuesByRepo: [
          { fullName: "acme/repo", issues: [parentIssue, childIssue] },
        ],
        fetchImpl,
      },
      {
        workItemRepo,
        workItemBlockRepo,
        githubRelationshipPendingRefRepo: pendingRefRepo,
        userAuthz: authzSpy.userAuthz,
        workItemEvents: noopWorkItemEvents,
        timeProvider: fixedTimeProvider(now),
      },
    );

    expect(authzSpy.callCount()).toBeGreaterThan(0);
    expect(fetchCalls()).toBeGreaterThan(0);
    expect(result.parentLinksApplied).toBe(1);
    expect(store.get(childWorkItem.id)?.parentWorkItemId).toBe(
      parentWorkItem.id,
    );
    expect(rows).toHaveLength(0);
  });
});

import { describe, expect, test } from "bun:test";
import { ingestGitHubIssueRelationships } from "@/integrations/github-ingest/application/ingest-github-issue-relationships";
import { WorkItemBlockEntity } from "@/work-items/work-item-block/domain/work-item-block-entity";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { fixedTimeProvider } from "tests/utils";
import {
  actorId,
  makeGithubRelationshipPendingRefRepo,
  makeGraphQLFetchImpl,
  makeIssue,
  makeUserAuthz,
  makeWorkItem,
  makeWorkItemBlockRepo,
  makeWorkItemRepo,
  noopWorkItemEvents,
  now,
  projectId,
} from "./ingest-github-issue-relationships-test-support";

/**
 * Blocking-pass and cross-cutting edge-case scenarios for
 * `ingestGitHubIssueRelationships` — see
 * `ingest-github-issue-relationships.parent.test.ts` for the parent-pass
 * scenarios, split out to keep each file under the repo's `max-lines` limit.
 */
describe("ingestGitHubIssueRelationships (blocking pass)", () => {
  test("creates a blocking edge from blockedBy data", async () => {
    const blockedIssue = makeIssue({ number: 1 });
    const blockingIssue = makeIssue({ number: 2 });

    const blockedWorkItem = makeWorkItem({ number: 1 });
    const blockingWorkItem = makeWorkItem({ number: 2 });

    const { repo: workItemRepo } = makeWorkItemRepo([
      blockedWorkItem,
      blockingWorkItem,
    ]);
    const { repo: workItemBlockRepo, created } = makeWorkItemBlockRepo();

    const result = await ingestGitHubIssueRelationships(
      {
        projectId,
        accessToken: "token",
        issuesByRepo: [
          { fullName: "acme/repo", issues: [blockedIssue, blockingIssue] },
        ],
        fetchImpl: makeGraphQLFetchImpl([
          [{ owner: "acme", repo: "repo", number: 2 }],
          [],
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

    expect(result.blocksCreated).toBe(1);
    expect(result.blocksSkipped).toBe(0);
    expect(created).toHaveLength(1);
    expect(created[0]?.blockedWorkItemId).toBe(parseUuidV7(blockedWorkItem.id));
    expect(created[0]?.blockingWorkItemId).toBe(
      parseUuidV7(blockingWorkItem.id),
    );
    expect(created[0]?.projectId).toBe(projectId);
    expect(created[0]?.createdByUserId).toBe(actorId);
  });

  test("does not re-create a blocking edge that already exists", async () => {
    const blockedIssue = makeIssue({ number: 1 });
    const blockingIssue = makeIssue({ number: 2 });

    const blockedWorkItem = makeWorkItem({ number: 1 });
    const blockingWorkItem = makeWorkItem({ number: 2 });

    const existingEdge = WorkItemBlockEntity.create({
      projectId,
      blockedWorkItemId: parseUuidV7(blockedWorkItem.id),
      blockingWorkItemId: parseUuidV7(blockingWorkItem.id),
      createdByUserId: actorId,
    });

    const { repo: workItemRepo } = makeWorkItemRepo([
      blockedWorkItem,
      blockingWorkItem,
    ]);
    const { repo: workItemBlockRepo, created } = makeWorkItemBlockRepo([
      existingEdge,
    ]);

    const result = await ingestGitHubIssueRelationships(
      {
        projectId,
        accessToken: "token",
        issuesByRepo: [
          { fullName: "acme/repo", issues: [blockedIssue, blockingIssue] },
        ],
        fetchImpl: makeGraphQLFetchImpl([
          [{ owner: "acme", repo: "repo", number: 2 }],
          [],
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

    expect(result.blocksCreated).toBe(0);
    expect(result.blocksSkipped).toBe(1);
    expect(created).toHaveLength(0);
  });

  test("skips a blocking edge that would create a cycle", async () => {
    // Existing: P depends on Q (blockedWorkItemId=P, blockingWorkItemId=Q),
    // Q depends on R. GitHub now reports R depends on P, which would close
    // the cycle P -> Q -> R -> P.
    const itemP = makeWorkItem({ number: 1 });
    const itemQ = makeWorkItem({ number: 2 });
    const itemR = makeWorkItem({ number: 3 });

    const existingEdges = [
      WorkItemBlockEntity.create({
        projectId,
        blockedWorkItemId: parseUuidV7(itemP.id),
        blockingWorkItemId: parseUuidV7(itemQ.id),
        createdByUserId: actorId,
      }),
      WorkItemBlockEntity.create({
        projectId,
        blockedWorkItemId: parseUuidV7(itemQ.id),
        blockingWorkItemId: parseUuidV7(itemR.id),
        createdByUserId: actorId,
      }),
    ];

    const issueR = makeIssue({ number: 3 });

    const { repo: workItemRepo } = makeWorkItemRepo([itemP, itemQ, itemR]);
    const { repo: workItemBlockRepo, created } =
      makeWorkItemBlockRepo(existingEdges);

    const result = await ingestGitHubIssueRelationships(
      {
        projectId,
        accessToken: "token",
        issuesByRepo: [{ fullName: "acme/repo", issues: [issueR] }],
        fetchImpl: makeGraphQLFetchImpl([
          [{ owner: "acme", repo: "repo", number: 1 }],
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

    expect(result.blocksCreated).toBe(0);
    expect(result.blocksSkipped).toBe(1);
    expect(created).toHaveLength(0);
  });

  test("skips self-referencing parent/block references without throwing", async () => {
    const selfIssue = makeIssue({ number: 1 });
    const selfWorkItem = makeWorkItem({ number: 1 });

    const { repo: workItemRepo } = makeWorkItemRepo([selfWorkItem]);
    const { repo: workItemBlockRepo, created } = makeWorkItemBlockRepo();

    const result = await ingestGitHubIssueRelationships(
      {
        projectId,
        accessToken: "token",
        issuesByRepo: [{ fullName: "acme/repo", issues: [selfIssue] }],
        fetchImpl: makeGraphQLFetchImpl(
          [[{ owner: "acme", repo: "repo", number: 1 }]],
          [{ owner: "acme", repo: "repo", number: 1 }],
        ),
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
    expect(result.blocksCreated).toBe(0);
    expect(result.blocksSkipped).toBe(1);
    expect(created).toHaveLength(0);
  });

  test("skips unresolved references (not-yet-synced/PR-authored issues) without throwing", async () => {
    const issue = makeIssue({ number: 1 });
    const workItem = makeWorkItem({ number: 1 });

    const { repo: workItemRepo, saved } = makeWorkItemRepo([workItem]);
    const { repo: workItemBlockRepo, created } = makeWorkItemBlockRepo();

    const result = await ingestGitHubIssueRelationships(
      {
        projectId,
        accessToken: "token",
        issuesByRepo: [{ fullName: "acme/repo", issues: [issue] }],
        fetchImpl: makeGraphQLFetchImpl(
          // Points at issues that were never ingested as a work item (e.g. a
          // PR, filtered out of Phase A's `issuesOnly`, or an out-of-scope
          // repo).
          [[{ owner: "acme", repo: "repo", number: 998 }]],
          [{ owner: "acme", repo: "repo", number: 999 }],
        ),
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
    expect(result.blocksCreated).toBe(0);
    expect(result.blocksSkipped).toBe(1);
    expect(saved).toHaveLength(0);
    expect(created).toHaveLength(0);
  });
});

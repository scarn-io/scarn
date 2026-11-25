import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { CoreError } from "@scarn/core/lib/errors";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { WorkItemRepo } from "@scarn/core/work-items/work-item/application/work-item-repo";
import { validateAndSetWorkItemParent } from "@scarn/core/work-items/work-item/application/validate-work-item-parent";
import type { WorkItemId } from "@scarn/core/work-items/work-item/domain/work-item-id";
import type { WorkItemEntity } from "@scarn/core/work-items/work-item/domain/work-item-entity";
import type { WorkItemBlockRepo } from "@scarn/core/work-items/work-item-block/application/work-item-block-repo";
import { createWorkItemBlock } from "@scarn/core/work-items/work-item-block/application/create-work-item-block";
import type { WorkItemEventsPort } from "@scarn/core/work-items/work-item/application/work-item-events-port";
import { noopLogger, type Logger } from "@scarn/observability/logging";
import {
  fetchIssueRelationshipsBatch,
  type GitHubIssueRef,
} from "../infra/github-relationships-client";
import {
  splitRepoFullName,
  type GitHubIssue,
} from "../infra/github-issues-client";
import type { GitHubRateLimitSignal } from "../infra/github-rate-limit";
import type {
  GithubRelationshipPendingRef,
  GithubRelationshipPendingRefRepo,
} from "./github-relationship-pending-ref-repo";

export type IngestGitHubIssueRelationshipsInput = {
  projectId: UuidV7;
  accessToken: string;
  issuesByRepo: Array<{ fullName: string; issues: GitHubIssue[] }>;
  fetchImpl?: typeof fetch;
  rateLimitSignal?: GitHubRateLimitSignal;
};

export type IngestGitHubIssueRelationshipsResult = {
  parentLinksApplied: number;
  parentLinksSkipped: number;
  blocksCreated: number;
  blocksSkipped: number;
};

export type IngestGitHubIssueRelationshipsDeps = {
  workItemRepo: WorkItemRepo;
  workItemBlockRepo: WorkItemBlockRepo;
  workItemEvents: WorkItemEventsPort;
  githubRelationshipPendingRefRepo: GithubRelationshipPendingRefRepo;
  userAuthz: UserAuthorizationService;
  timeProvider: TimeProvider;
  logger?: Logger;
};

const refKey = (ref: GitHubIssueRef): string =>
  `${ref.owner}/${ref.repo}#${String(ref.number)}`;

type IssueContext = {
  ownKey: string;
  ownRef: GitHubIssueRef;
};

type PendingRefIdentity = Pick<
  GithubRelationshipPendingRef,
  "workItemId" | "kind" | "targetPlatformKey"
>;

/**
 * A candidate reference to resolve — either built fresh from this run's
 * `issuesByRepo` (`fresh: true`), sourced from a previously-persisted
 * `github_relationship_pending_refs` row (`hadPendingRow: true`), or both at
 * once (the same reference was already pending from an earlier run *and* was
 * fetched again this run — deduped onto a single candidate by `(workItemId,
 * targetPlatformKey)` identity so it's only resolved once and the pending
 * table is only written once for it).
 */
type RelationshipCandidate = {
  workItemId: WorkItemId;
  targetPlatformKey: string;
  logKey: string;
  fresh: boolean;
  hadPendingRow: boolean;
};

const candidateIdentity = (
  workItemId: WorkItemId,
  targetPlatformKey: string,
): string => `${workItemId}::${targetPlatformKey}`;

const mergeFreshCandidate = (
  candidates: Map<string, RelationshipCandidate>,
  workItemId: WorkItemId,
  targetPlatformKey: string,
  logKey: string,
): void => {
  const identity = candidateIdentity(workItemId, targetPlatformKey);
  const existing = candidates.get(identity);
  if (existing) {
    existing.fresh = true;
    return;
  }
  candidates.set(identity, {
    workItemId,
    targetPlatformKey,
    logKey,
    fresh: true,
    hadPendingRow: false,
  });
};

const mergePendingCandidate = (
  candidates: Map<string, RelationshipCandidate>,
  pending: GithubRelationshipPendingRef,
  workItemsById: Map<WorkItemId, WorkItemEntity>,
): void => {
  const identity = candidateIdentity(
    pending.workItemId,
    pending.targetPlatformKey,
  );
  const existing = candidates.get(identity);
  if (existing) {
    existing.hadPendingRow = true;
    return;
  }
  candidates.set(identity, {
    workItemId: pending.workItemId,
    targetPlatformKey: pending.targetPlatformKey,
    logKey:
      workItemsById.get(pending.workItemId)?.platformKey ?? pending.workItemId,
    fresh: false,
    hadPendingRow: true,
  });
};

/**
 * Phase B of the GitHub sync run (see `docs/github-relationship-ingestion-plan.md`):
 * resolves GitHub's `parent` and `blockedBy` relationship data — both fetched
 * via a single batched GraphQL query (`fetchIssueRelationshipsBatch`) — onto
 * Scarn work items and applies it as parent/child and blocking
 * relationships, additively and without ever overwriting a relationship a
 * user (or a prior sync) already established (Decisions 7 and 8).
 *
 * Also reconciles the `github_relationship_pending_refs` table (see
 * `docs/github-relationship-pending-references-plan.md`): every previously-
 * unresolved reference for `projectId` is re-attempted against the current,
 * just-widened set of known work items alongside this run's freshly-fetched
 * issues. A reference that resolves (or is now permanently rejected) has its
 * pending row deleted; one that's still unresolved is left in place, or
 * persisted for the first time if it's newly discovered this run.
 *
 * Must be called only after every repo in the run has already been upserted
 * by `ingestGitHubIssues` (Decision 4), so same-run cross-repo references
 * resolve regardless of repo order.
 *
 * The whole pass is skipped — no GitHub relationship-API call, no authz
 * check, no work-item loads — when this run had zero changed issues *and*
 * the project's pending-refs backlog is empty (`docs/plans/
 * github-integration-sync-scaling.md`, Phase 3, Decision 7). Either one
 * being non-empty still runs the full pass.
 *
 * Expected validation rejections (cross-project, self-reference,
 * would-create-a-cycle, reciprocal/already-exists) are logged and skipped.
 * Any other error — from `fetchIssueRelationshipsBatch`, `workItemRepo`, or
 * `workItemBlockRepo` — propagates uncaught (Decision 11), so it bubbles to
 * the caller's existing failure handling exactly like a Phase A failure does.
 */
export const ingestGitHubIssueRelationships = async (
  input: IngestGitHubIssueRelationshipsInput,
  deps: IngestGitHubIssueRelationshipsDeps,
): Promise<IngestGitHubIssueRelationshipsResult> => {
  const logger = deps.logger ?? noopLogger;
  const {
    workItemRepo,
    workItemBlockRepo,
    workItemEvents,
    githubRelationshipPendingRefRepo,
    userAuthz,
    timeProvider,
  } = deps;

  const issueContexts: IssueContext[] = [];
  for (const repo of input.issuesByRepo) {
    const { owner, repo: repoName } = splitRepoFullName(repo.fullName);
    for (const issue of repo.issues) {
      issueContexts.push({
        ownKey: `${repo.fullName}#${String(issue.number)}`,
        ownRef: { owner, repo: repoName, number: issue.number },
      });
    }
  }

  const pendingRefs = await githubRelationshipPendingRefRepo.listByProjectId(
    input.projectId,
  );

  // Decision 7 (github-integration-sync-scaling plan, Phase 3): skip the
  // whole resolution pass — no GitHub relationship-API call, no authz check,
  // no work-item loads — when there is provably nothing to do: this run
  // fetched zero changed issues (`issueContexts` is built straight from
  // `issuesByRepo`, itself `ingestGitHubIssues`'s `perRepo[].issues`) *and*
  // the project's pending-refs backlog is empty. Either one being non-empty
  // still requires a full pass (a non-empty backlog may resolve against
  // nothing new from GitHub but against work items upserted by an earlier,
  // unrelated run).
  if (issueContexts.length === 0 && pendingRefs.length === 0) {
    logger.debug(
      { projectId: input.projectId },
      "Skipping GitHub relationship resolution: no changed issues and no pending references",
    );
    return {
      parentLinksApplied: 0,
      parentLinksSkipped: 0,
      blocksCreated: 0,
      blocksSkipped: 0,
    };
  }

  const relationshipsMap = await fetchIssueRelationshipsBatch({
    accessToken: input.accessToken,
    refs: issueContexts.map((ctx) => ctx.ownRef),
    fetchImpl: input.fetchImpl,
    rateLimitSignal: input.rateLimitSignal,
  });

  const referencedKeys = new Set<string>();
  for (const ctx of issueContexts) {
    referencedKeys.add(ctx.ownKey);
    const relationships = relationshipsMap.get(ctx.ownKey);
    if (relationships?.parent) referencedKeys.add(refKey(relationships.parent));
    for (const blockingRef of relationships?.blockedBy ?? []) {
      referencedKeys.add(refKey(blockingRef));
    }
  }
  for (const pending of pendingRefs) {
    referencedKeys.add(pending.targetPlatformKey);
  }

  const loadedWorkItems = await workItemRepo.loadManyByPlatformIdentities(
    [...referencedKeys].map((sourceIdentity) => ({
      projectId: input.projectId,
      platform: "github" as const,
      sourceIdentity,
    })),
  );
  const workItemsByKey = new Map(
    loadedWorkItems.map((workItem) => [workItem.platformKey, workItem]),
  );

  const pendingWorkItemIds = [...new Set(pendingRefs.map((p) => p.workItemId))];
  const pendingWorkItems = await workItemRepo.loadMany(pendingWorkItemIds);

  const workItemsById = new Map<WorkItemId, WorkItemEntity>();
  for (const workItem of loadedWorkItems)
    workItemsById.set(workItem.id, workItem);
  for (const workItem of pendingWorkItems)
    workItemsById.set(workItem.id, workItem);

  await userAuthz.requireProjectPermission({
    projectId: input.projectId,
    permission: "work-items:write",
  });

  const now = timeProvider.now();
  let parentLinksApplied = 0;
  let parentLinksSkipped = 0;
  let blocksCreated = 0;
  let blocksSkipped = 0;

  const pendingDeletions: PendingRefIdentity[] = [];
  const pendingUpserts: Array<Omit<GithubRelationshipPendingRef, "id">> = [];

  const parentCandidates = new Map<string, RelationshipCandidate>();
  for (const ctx of issueContexts) {
    const parentRef = relationshipsMap.get(ctx.ownKey)?.parent;
    if (!parentRef) continue;
    const workItem = workItemsByKey.get(ctx.ownKey);
    if (!workItem) {
      // The referencing issue's own work item didn't resolve (shouldn't
      // normally happen — it was just upserted by Phase A — but handled
      // defensively). There's no `workItemId` to key a pending row on, so
      // there's nothing to persist; just skip.
      parentLinksSkipped++;
      logger.debug(
        { issueKey: ctx.ownKey, parentKey: refKey(parentRef) },
        "Skipping GitHub parent link: reference did not resolve to a known work item",
      );
      continue;
    }
    mergeFreshCandidate(
      parentCandidates,
      workItem.id,
      refKey(parentRef),
      ctx.ownKey,
    );
  }
  for (const pending of pendingRefs) {
    if (pending.kind !== "parent") continue;
    mergePendingCandidate(parentCandidates, pending, workItemsById);
  }

  for (const candidate of parentCandidates.values()) {
    const workItem = workItemsById.get(candidate.workItemId);
    if (!workItem) {
      parentLinksSkipped++;
      continue;
    }
    const parentWorkItem = workItemsByKey.get(candidate.targetPlatformKey);
    const identity: PendingRefIdentity = {
      workItemId: candidate.workItemId,
      kind: "parent",
      targetPlatformKey: candidate.targetPlatformKey,
    };

    if (!parentWorkItem) {
      parentLinksSkipped++;
      logger.debug(
        { issueKey: candidate.logKey, parentKey: candidate.targetPlatformKey },
        "Skipping GitHub parent link: reference did not resolve to a known work item",
      );
      if (candidate.fresh && !candidate.hadPendingRow) {
        pendingUpserts.push({ projectId: input.projectId, ...identity });
      }
      continue;
    }

    if (workItem.parentWorkItemId) {
      // Fill-in-if-unset only (Decision 7): never overwrite an existing
      // parent link, whether it was set manually or by a prior sync. Now
      // permanent from the pending-refs table's point of view too — this
      // reference will never apply, so any pending row for it is stale.
      parentLinksSkipped++;
      if (candidate.hadPendingRow) pendingDeletions.push(identity);
      continue;
    }

    try {
      const reparented = await validateAndSetWorkItemParent(
        workItem,
        parentWorkItem,
        { workItemRepo },
        now,
      );
      const saved = await workItemRepo.save(reparented);
      workItemsById.set(saved.id, saved);
      workItemsByKey.set(saved.platformKey, saved);
      parentLinksApplied++;
      if (candidate.hadPendingRow) pendingDeletions.push(identity);
    } catch (error) {
      if (error instanceof CoreError) {
        parentLinksSkipped++;
        logger.warn(
          {
            err: error,
            issueKey: candidate.logKey,
            parentKey: candidate.targetPlatformKey,
          },
          "Skipping GitHub parent link: rejected by validation",
        );
        if (candidate.hadPendingRow) pendingDeletions.push(identity);
        continue;
      }
      throw error;
    }
  }

  const blockCandidates = new Map<string, RelationshipCandidate>();
  for (const ctx of issueContexts) {
    const blockedWorkItem = workItemsByKey.get(ctx.ownKey);
    for (const blockingRef of relationshipsMap.get(ctx.ownKey)?.blockedBy ??
      []) {
      const blockingKey = refKey(blockingRef);
      if (!blockedWorkItem) {
        blocksSkipped++;
        logger.debug(
          { blockedKey: ctx.ownKey, blockingKey },
          "Skipping GitHub block edge: reference did not resolve to a known work item",
        );
        continue;
      }
      mergeFreshCandidate(
        blockCandidates,
        blockedWorkItem.id,
        blockingKey,
        ctx.ownKey,
      );
    }
  }
  for (const pending of pendingRefs) {
    if (pending.kind !== "blocked_by") continue;
    mergePendingCandidate(blockCandidates, pending, workItemsById);
  }

  for (const candidate of blockCandidates.values()) {
    const blockedWorkItem = workItemsById.get(candidate.workItemId);
    if (!blockedWorkItem) {
      blocksSkipped++;
      continue;
    }
    const blockingWorkItem = workItemsByKey.get(candidate.targetPlatformKey);
    const identity: PendingRefIdentity = {
      workItemId: candidate.workItemId,
      kind: "blocked_by",
      targetPlatformKey: candidate.targetPlatformKey,
    };

    if (!blockingWorkItem) {
      blocksSkipped++;
      logger.debug(
        {
          blockedKey: candidate.logKey,
          blockingKey: candidate.targetPlatformKey,
        },
        "Skipping GitHub block edge: reference did not resolve to a known work item",
      );
      if (candidate.fresh && !candidate.hadPendingRow) {
        pendingUpserts.push({ projectId: input.projectId, ...identity });
      }
      continue;
    }

    // Additive-only (Decision 8): this exact pair may already have been
    // created by a prior sync run (GitHub reports the same `blockedBy`
    // edge on every run until it's resolved). `createWorkItemBlock`'s
    // validation only rejects the *reciprocal* pair and would-be cycles, not an exact
    // repeat of an already-existing edge — checked here so a routine
    // re-sync never hits the DB's unique-pair constraint. A pending row that
    // reprocesses into an already-existing edge is just as permanently
    // resolved as one that creates a new edge.
    const existingEdge = await workItemBlockRepo.loadByPair(
      parseUuidV7(blockedWorkItem.id),
      parseUuidV7(blockingWorkItem.id),
    );
    if (existingEdge) {
      blocksSkipped++;
      if (candidate.hadPendingRow) pendingDeletions.push(identity);
      continue;
    }

    try {
      await createWorkItemBlock(
        {
          blockedWorkItemId: blockedWorkItem.id,
          blockingWorkItemId: blockingWorkItem.id,
        },
        {
          userAuthz,
          workItemRepo,
          workItemBlockRepo,
          workItemEvents,
          timeProvider,
        },
      );
      blocksCreated++;
      if (candidate.hadPendingRow) pendingDeletions.push(identity);
    } catch (error) {
      if (error instanceof CoreError) {
        blocksSkipped++;
        logger.warn(
          {
            err: error,
            blockedKey: candidate.logKey,
            blockingKey: candidate.targetPlatformKey,
          },
          "Skipping GitHub block edge: rejected by validation",
        );
        if (candidate.hadPendingRow) pendingDeletions.push(identity);
        continue;
      }
      throw error;
    }
  }

  if (pendingDeletions.length > 0) {
    await githubRelationshipPendingRefRepo.deleteMany(pendingDeletions);
  }
  if (pendingUpserts.length > 0) {
    await githubRelationshipPendingRefRepo.upsertMany(pendingUpserts);
  }

  return {
    parentLinksApplied,
    parentLinksSkipped,
    blocksCreated,
    blocksSkipped,
  };
};

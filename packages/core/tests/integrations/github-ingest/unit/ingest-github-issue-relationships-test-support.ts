import type { GitHubIssue } from "@/integrations/github-ingest/infra/github-issues-client";
import type { GitHubIssueRef } from "@/integrations/github-ingest/infra/github-relationships-client";
import type {
  GithubRelationshipPendingRef,
  GithubRelationshipPendingRefRepo,
} from "@/integrations/github-ingest/application/github-relationship-pending-ref-repo";
import type { WorkItemEventsPort } from "@/work-items/work-item/application/work-item-events-port";
import type { WorkItemRepo } from "@/work-items/work-item/application/work-item-repo";
import { WorkItemEntity } from "@/work-items/work-item/domain/work-item-entity";
import type { WorkItemId } from "@/work-items/work-item/domain/work-item-id";
import type { WorkItemBlockRepo } from "@/work-items/work-item-block/application/work-item-block-repo";
import type { WorkItemBlockEntity } from "@/work-items/work-item-block/domain/work-item-block-entity";
import type { UserAuthorizationService } from "@/access/authorization/application/user-authorization-service";
import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@/common/contracts/uuid-v7";

/**
 * Shared fixtures/fakes for `ingest-github-issue-relationships.*.test.ts` —
 * split out of the test files themselves to keep each under the repo's
 * `max-lines` limit.
 */

export const projectId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f02");
export const otherProjectId = parseUuidV7(
  "0196917c-532c-75aa-b7d5-0a84b71a1f03",
);
export const actorId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f04");
export const now = new Date("2026-06-01T12:00:00.000Z");

export const makeIssue = (
  overrides: Partial<GitHubIssue> & { number: number },
): GitHubIssue => ({
  id: overrides.id ?? overrides.number,
  node_id: overrides.node_id ?? `I_${String(overrides.number)}`,
  number: overrides.number,
  title: overrides.title ?? `Issue ${String(overrides.number)}`,
  body: overrides.body ?? "Body",
  html_url:
    overrides.html_url ??
    `https://github.com/acme/repo/issues/${String(overrides.number)}`,
  state: overrides.state ?? "open",
  state_reason: overrides.state_reason ?? null,
  user: overrides.user ?? { login: "alice" },
  labels: overrides.labels ?? [],
  assignees: overrides.assignees ?? [],
  comments: overrides.comments ?? 0,
  created_at: overrides.created_at ?? "2026-05-01T00:00:00Z",
  updated_at: overrides.updated_at ?? "2026-05-01T00:00:00Z",
  closed_at: overrides.closed_at ?? null,
  pull_request: overrides.pull_request,
});

/**
 * Fake `WorkItemRepo`, keyed by id (for `load`, used by the parent-cycle
 * walk) and matched by `platform`/`platformKey` alone for
 * `loadManyByPlatformIdentities` — deliberately *not* filtering by the
 * identity's `projectId` (unlike the real Drizzle repo) so a test can set up
 * an otherwise-unreachable "same platformKey resolves to a different
 * project" case to exercise `validateAndSetWorkItemParent`'s cross-project
 * rejection as defense in depth.
 */
export const makeWorkItemRepo = (
  items: WorkItemEntity[],
): {
  repo: WorkItemRepo;
  store: Map<WorkItemId, WorkItemEntity>;
  saved: WorkItemEntity[];
} => {
  const store = new Map<WorkItemId, WorkItemEntity>(
    items.map((item) => [item.id, item]),
  );
  const saved: WorkItemEntity[] = [];

  const repo: WorkItemRepo = {
    load: (id) => Promise.resolve(store.get(id) ?? null),
    loadMany: (ids) =>
      Promise.resolve(
        ids
          .map((id) => store.get(id))
          .filter((item): item is WorkItemEntity => Boolean(item)),
      ),
    listChildren: () => Promise.resolve([]),
    countSpawnedByTask: () => Promise.resolve(0),
    maxSourceUpdatedAt: () => Promise.resolve(null),
    listPageByProjectId: () => Promise.resolve({ items: [], total: 0 }),
    listFieldOptions: () => Promise.resolve([]),
    listLabels: () => Promise.resolve([]),
    loadByPlatformIdentity: (_projectId, platform, sourceIdentity) =>
      Promise.resolve(
        [...store.values()].find(
          (item) =>
            item.platform === platform && item.platformKey === sourceIdentity,
        ) ?? null,
      ),
    loadManyByPlatformIdentities: (identities) =>
      Promise.resolve(
        identities
          .map((identity) =>
            [...store.values()].find(
              (item) =>
                item.platform === identity.platform &&
                item.platformKey === identity.sourceIdentity,
            ),
          )
          .filter((item): item is WorkItemEntity => Boolean(item)),
      ),
    create: (item) => {
      store.set(item.id, item);
      return Promise.resolve(item);
    },
    createMany: (items2) => {
      for (const item of items2) store.set(item.id, item);
      return Promise.resolve(items2);
    },
    save: (item) => {
      store.set(item.id, item);
      saved.push(item);
      return Promise.resolve(item);
    },
    saveDescription: (item) => {
      store.set(item.id, item);
      return Promise.resolve(item);
    },
    saveMany: (items2) => {
      for (const item of items2) {
        store.set(item.id, item);
        saved.push(item);
      }
      return Promise.resolve(items2);
    },
    saveManyIfSourceNewer: (items2) => {
      for (const item of items2) {
        store.set(item.id, item);
        saved.push(item);
      }
      return Promise.resolve(items2);
    },
    setStateMany: (items2) => {
      for (const item of items2) {
        store.set(item.id, item);
      }
      return Promise.resolve(items2);
    },
    delete: () => Promise.resolve(0),
    deleteMany: () => Promise.resolve(0),
    deleteByProjectId: () => Promise.resolve(0),
  };

  return { repo, store, saved };
};

export const makeWorkItemBlockRepo = (
  initialEdges: WorkItemBlockEntity[] = [],
): {
  repo: WorkItemBlockRepo;
  edges: WorkItemBlockEntity[];
  created: WorkItemBlockEntity[];
} => {
  const edges = [...initialEdges];
  const created: WorkItemBlockEntity[] = [];

  const repo: WorkItemBlockRepo = {
    create: (block) => {
      edges.push(block);
      created.push(block);
      return Promise.resolve(block);
    },
    load: (id) => Promise.resolve(edges.find((edge) => edge.id === id) ?? null),
    listByWorkItem: (workItemId) =>
      Promise.resolve(
        edges.filter(
          (edge) =>
            edge.blockedWorkItemId === workItemId ||
            edge.blockingWorkItemId === workItemId,
        ),
      ),
    loadByPair: (blockedWorkItemId, blockingWorkItemId) =>
      Promise.resolve(
        edges.find(
          (edge) =>
            edge.blockedWorkItemId === blockedWorkItemId &&
            edge.blockingWorkItemId === blockingWorkItemId,
        ) ?? null,
      ),
    // Mirrors `isWorkItemReachableViaBlocks`'s semantics: starting at
    // `fromWorkItemId`, walk forward from a blocked item to whatever blocks
    // it, transitively, scoped to `projectId`.
    isReachable: (projectIdArg, fromWorkItemId, toWorkItemId) => {
      const visited = new Set<UuidV7>();
      const queue: UuidV7[] = [fromWorkItemId];
      while (queue.length > 0) {
        const current = queue.shift();
        if (!current) continue;
        for (const edge of edges) {
          if (edge.projectId !== projectIdArg) continue;
          if (
            edge.blockedWorkItemId === current &&
            !visited.has(edge.blockingWorkItemId)
          ) {
            visited.add(edge.blockingWorkItemId);
            queue.push(edge.blockingWorkItemId);
          }
        }
      }
      return Promise.resolve(visited.has(toWorkItemId));
    },
    delete: () => Promise.resolve(0),
    listIdsWithOpenBlockers: () => Promise.resolve([]),
    listOpenBlockerIdsByBlocked: () => Promise.resolve(new Map()),
    listIdsBlockedBy: () => Promise.resolve([]),
  };

  return { repo, edges, created };
};

export const noopWorkItemEvents: WorkItemEventsPort = {
  created: () => Promise.resolve(),
  mayHaveBecomeReady: () => Promise.resolve(),
  closed: () => Promise.resolve(),
  labelsAdded: () => Promise.resolve(),
};

/**
 * Fake `GithubRelationshipPendingRefRepo`, in-memory and scoped by identity
 * (`workItemId` + `kind` + `targetPlatformKey`), mirroring the real Drizzle
 * repo's unique index — `upsertMany` is a no-op for an identity already
 * present. Exposes the live `rows` array plus `upserted`/`deleted` call logs
 * so tests can assert exactly what the reconciliation step wrote.
 */
export const makeGithubRelationshipPendingRefRepo = (
  initialRows: GithubRelationshipPendingRef[] = [],
): {
  repo: GithubRelationshipPendingRefRepo;
  rows: GithubRelationshipPendingRef[];
  upserted: Array<Omit<GithubRelationshipPendingRef, "id">>;
  deleted: Array<
    Pick<
      GithubRelationshipPendingRef,
      "workItemId" | "kind" | "targetPlatformKey"
    >
  >;
} => {
  const rows = [...initialRows];
  const upserted: Array<Omit<GithubRelationshipPendingRef, "id">> = [];
  const deleted: Array<
    Pick<
      GithubRelationshipPendingRef,
      "workItemId" | "kind" | "targetPlatformKey"
    >
  > = [];

  const matches = (
    row: Pick<
      GithubRelationshipPendingRef,
      "workItemId" | "kind" | "targetPlatformKey"
    >,
    ref: Pick<
      GithubRelationshipPendingRef,
      "workItemId" | "kind" | "targetPlatformKey"
    >,
  ): boolean =>
    row.workItemId === ref.workItemId &&
    row.kind === ref.kind &&
    row.targetPlatformKey === ref.targetPlatformKey;

  const repo: GithubRelationshipPendingRefRepo = {
    listByProjectId: (projectIdArg) =>
      Promise.resolve(rows.filter((row) => row.projectId === projectIdArg)),
    upsertMany: (refs) => {
      for (const ref of refs) {
        upserted.push(ref);
        if (rows.some((row) => matches(row, ref))) continue;
        rows.push({ ...ref, id: createUuidV7() });
      }
      return Promise.resolve();
    },
    deleteMany: (refs) => {
      for (const ref of refs) {
        deleted.push(ref);
        const index = rows.findIndex((row) => matches(row, ref));
        if (index !== -1) rows.splice(index, 1);
      }
      return Promise.resolve();
    },
  };

  return { repo, rows, upserted, deleted };
};

export const makeUserAuthz = (): UserAuthorizationService => ({
  actorId,
  requireProjectMember: () =>
    Promise.reject(new Error("requireProjectMember is not used here")),
  requireProjectPermission: () =>
    Promise.resolve({ membership: null, isPublicNonMemberGrant: false }),
});

export const makeWorkItem = (opts: {
  projectId?: UuidV7;
  number: number;
  fullName?: string;
  parentWorkItemId?: WorkItemId | null;
}): WorkItemEntity =>
  WorkItemEntity.create({
    projectId: opts.projectId ?? projectId,
    platform: "github",
    platformKey: `${opts.fullName ?? "acme/repo"}#${String(opts.number)}`,
    title: `Issue ${String(opts.number)}`,
    parentWorkItemId: opts.parentWorkItemId ?? null,
  });

/**
 * Builds a `fetchImpl` for the GraphQL `parent`/`blockedBy` batch request.
 * Assumes a single repo/single batch (well under
 * `GITHUB_RELATIONSHIP_BATCH_SIZE`), so the alias index for each issue
 * matches its position in the `refs` the caller passes to
 * `fetchIssueRelationshipsBatch` (i.e. the order issues appear across
 * `issuesByRepo`). `parentInOrder` is optional and defaults to "no parent
 * set" for every issue, matching the pre-parent-support fixture shape.
 */
export const makeGraphQLFetchImpl = (
  blockedByInOrder: GitHubIssueRef[][],
  parentInOrder: Array<GitHubIssueRef | null> = [],
): typeof fetch =>
  (() => {
    const issueFields: Record<string, unknown> = {};
    blockedByInOrder.forEach((refs, index) => {
      const parent = parentInOrder[index] ?? null;
      issueFields[`i${String(index)}`] = {
        parent: parent
          ? {
              number: parent.number,
              repository: {
                owner: { login: parent.owner },
                name: parent.repo,
              },
            }
          : null,
        blockedBy: {
          nodes: refs.map((ref) => ({
            number: ref.number,
            repository: { owner: { login: ref.owner }, name: ref.repo },
          })),
        },
      };
    });
    return Promise.resolve(
      new Response(JSON.stringify({ data: { r0: issueFields } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;

/** Convenience: no issue in the run has any `blockedBy` edges. */
export const noBlockedBy = (count: number): GitHubIssueRef[][] =>
  Array.from({ length: count }, () => [] as GitHubIssueRef[]);

import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { WorkItemId } from "@scarn/core/work-items/work-item/domain/work-item-id";

export type GithubRelationshipPendingRef = {
  id: UuidV7;
  projectId: UuidV7;
  // The work item that HOLDS the unresolved reference (the child, for a
  // "parent" row; the blocked item, for a "blocked_by" row).
  workItemId: WorkItemId;
  kind: "parent" | "blocked_by";
  // Raw target platform key, e.g. "owner/repo#128" — same format as
  // `workItems.platformKey`, resolved the same way via
  // `loadManyByPlatformIdentities`.
  targetPlatformKey: string;
};

export type GithubRelationshipPendingRefRepo = {
  listByProjectId(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<GithubRelationshipPendingRef[]>;
  /** Insert-if-not-exists (relies on the unique index); no-op on conflict. */
  upsertMany(
    refs: Array<Omit<GithubRelationshipPendingRef, "id">>,
    dbExecutor?: DbExecutor,
  ): Promise<void>;
  /** Deletes by the same (workItemId, kind, targetPlatformKey) identity. */
  deleteMany(
    refs: Array<
      Pick<
        GithubRelationshipPendingRef,
        "workItemId" | "kind" | "targetPlatformKey"
      >
    >,
    dbExecutor?: DbExecutor,
  ): Promise<void>;
};

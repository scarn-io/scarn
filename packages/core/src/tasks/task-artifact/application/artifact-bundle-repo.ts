import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { ArtifactContract } from "../contracts/task-artifact-contracts";
import type { ArtifactBundleStatus } from "../domain/artifact-bundle";

/**
 * A stored artifact bundle. `rootPath` is run-relative; `entryPath` is
 * relative to `rootPath`. `fileCount`/`sizeBytes`/`finalizedAt` are null
 * until the bundle is finalized.
 */
export type ArtifactBundleRecord = {
  id: UuidV7;
  projectId: UuidV7;
  taskRunId: UuidV7;
  name: string;
  fieldPath: string | null;
  rootPath: string;
  entryPath: string;
  status: ArtifactBundleStatus;
  fileCount: number | null;
  sizeBytes: number | null;
  createdAt: string;
  finalizedAt: string | null;
  /** Set once the bundle aged past retention (see `clearExpiredArtifacts`). */
  expiredAt: string | null;
  deletedAt: string | null;
};

/** Input for {@link ArtifactBundleRepo.create}; paths must already be validated via `parseArtifactBundleSpec`. */
export type CreateArtifactBundleRow = {
  id: UuidV7;
  projectId: UuidV7;
  taskRunId: UuidV7;
  name: string;
  fieldPath: string | null;
  rootPath: string;
  entryPath: string;
};

export type FinalizeArtifactBundleInput =
  | { status: "ready"; fileCount: number; sizeBytes: number }
  | { status: "failed"; fileCount?: number | null; sizeBytes?: number | null };

export type ArtifactBundleRepo = {
  /**
   * Insert a new `pending` bundle. Throws `ResourceConflictError`
   * (code `ARTIFACT_BUNDLE_CONFLICT`) when the task run already has a bundle
   * with this name.
   */
  create(
    input: CreateArtifactBundleRow,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactBundleRecord>;
  /**
   * Move a `pending` bundle to `ready` or `failed`, recording its file count,
   * total size and `finalizedAt`. Returns the updated bundle, or null when
   * no non-deleted `pending` bundle with that id exists (already finalized,
   * deleted or missing), so a repeated finalize can't flip the status.
   */
  finalize(
    bundleId: UuidV7,
    input: FinalizeArtifactBundleInput,
    finalizedAt: Date,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactBundleRecord | null>;
  /** Load a non-deleted bundle by id, or null. */
  findById(
    bundleId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactBundleRecord | null>;
  /** Load a bundle by id even when soft-deleted (check `deletedAt`), or null. */
  findByIdIncludingDeleted(
    bundleId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactBundleRecord | null>;
  /** Load the non-deleted bundles with these ids; missing ids are absent. */
  findManyByIds(
    bundleIds: UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactBundleRecord[]>;
  /** List the non-deleted bundles of a task run, newest first. */
  listByTask(
    taskRunId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactBundleRecord[]>;
  /**
   * Find the non-deleted member artifact of a bundle at `path`, which is
   * relative to the bundle root (e.g. `index.html`, `assets/app.js`), not
   * to the run. The member's stored `relativeStorePath` is
   * `<rootPath>/<path>`. Returns null when the bundle or member is missing;
   * throws `CoreValidationError` when `path` is not a safe relative path.
   */
  findMember(
    bundleId: UuidV7,
    path: string,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactContract | null>;
  /** List a bundle's non-deleted member artifacts, newest first. */
  listMembers(
    bundleId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactContract[]>;
  /**
   * List non-deleted bundles still `pending` whose `createdAt` is strictly
   * before `olderThan`, oldest first (for the stale-bundle sweep).
   */
  listStalePending(
    olderThan: Date,
    limit?: number,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactBundleRecord[]>;
};

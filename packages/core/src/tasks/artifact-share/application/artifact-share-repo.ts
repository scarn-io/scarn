import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { ArtifactShareCreatedVia } from "../domain/artifact-share";

/** A stored share link for a bundle. Active while `revokedAt` is null. */
export type ArtifactShareRecord = {
  id: UuidV7;
  projectId: UuidV7;
  bundleId: UuidV7;
  createdVia: ArtifactShareCreatedVia;
  createdByUserId: UuidV7 | null;
  createdByTaskId: UuidV7 | null;
  createdAt: string;
  revokedAt: string | null;
  revokedByUserId: UuidV7 | null;
};

export type CreateArtifactShareRow = {
  id: UuidV7;
  projectId: UuidV7;
  bundleId: UuidV7;
  createdVia: ArtifactShareCreatedVia;
  createdByUserId: UuidV7 | null;
  createdByTaskId: UuidV7 | null;
};

export type ArtifactShareRepo = {
  /**
   * Insert an active share, or return the bundle's existing active share
   * when it already has one (a bundle has at most one).
   */
  createOrGetActive(
    input: CreateArtifactShareRow,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactShareRecord>;
  /** Load a share by id, active or revoked, or null. */
  findById(
    shareId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactShareRecord | null>;
  /** The bundle's active share, or null. */
  findActiveByBundle(
    bundleId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactShareRecord | null>;
  /**
   * List up to `limit + 1` active shares of a project whose bundle is not
   * deleted, newest first. Callers slice to `limit` and treat a longer
   * result as "more exist".
   */
  listActiveByProject(
    projectId: UuidV7,
    limit: number,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactShareRecord[]>;
  /** Revoke the bundle's active share; returns it, or null when there was none. */
  revokeActiveByBundle(
    bundleId: UuidV7,
    input: { revokedAt: Date; revokedByUserId: UuidV7 | null },
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactShareRecord | null>;
};

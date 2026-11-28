import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { artifactShares, taskArtifactBundles } from "@scarn/core/lib/db/schema";
import { PersistenceError } from "@scarn/core/lib/errors";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type {
  ArtifactShareRecord,
  ArtifactShareRepo,
  CreateArtifactShareRow,
} from "../application/artifact-share-repo";

const toRecord = (
  row: typeof artifactShares.$inferSelect,
): ArtifactShareRecord => ({
  id: row.id as UuidV7,
  projectId: row.projectId as UuidV7,
  bundleId: row.bundleId as UuidV7,
  createdVia: row.createdVia,
  createdByUserId: row.createdByUserId as UuidV7 | null,
  createdByTaskId: row.createdByTaskId as UuidV7 | null,
  createdAt: row.createdAt.toISOString(),
  revokedAt: row.revokedAt?.toISOString() ?? null,
  revokedByUserId: row.revokedByUserId as UuidV7 | null,
});

export class DrizzleArtifactShareRepo implements ArtifactShareRepo {
  async createOrGetActive(
    input: CreateArtifactShareRow,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactShareRecord> {
    const db = dbExecutor ?? getDb();
    const [inserted] = await db
      .insert(artifactShares)
      .values({
        id: input.id,
        projectId: input.projectId,
        bundleId: input.bundleId,
        createdVia: input.createdVia,
        createdByUserId: input.createdByUserId,
        createdByTaskId: input.createdByTaskId,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) {
      return toRecord(inserted);
    }

    const existing = await this.findActiveByBundle(input.bundleId, db);
    if (!existing) {
      throw new PersistenceError(
        `Failed to create a share for artifact bundle ${input.bundleId}`,
        "ARTIFACT_SHARE_CREATE_FAILED",
      );
    }
    return existing;
  }

  async findById(
    shareId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactShareRecord | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(artifactShares)
      .where(eq(artifactShares.id, shareId))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async findActiveByBundle(
    bundleId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactShareRecord | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(artifactShares)
      .where(
        and(
          eq(artifactShares.bundleId, bundleId),
          isNull(artifactShares.revokedAt),
        ),
      )
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async listActiveByProject(
    projectId: UuidV7,
    limit: number,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactShareRecord[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select({ share: artifactShares })
      .from(artifactShares)
      .innerJoin(
        taskArtifactBundles,
        eq(taskArtifactBundles.id, artifactShares.bundleId),
      )
      .where(
        and(
          eq(artifactShares.projectId, projectId),
          isNull(artifactShares.revokedAt),
          isNull(taskArtifactBundles.deletedAt),
        ),
      )
      .orderBy(desc(artifactShares.createdAt), desc(artifactShares.id))
      .limit(limit + 1);
    return rows.map((row) => toRecord(row.share));
  }

  async revokeActiveByBundle(
    bundleId: UuidV7,
    input: { revokedAt: Date; revokedByUserId: UuidV7 | null },
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactShareRecord | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .update(artifactShares)
      .set({
        revokedAt: input.revokedAt,
        revokedByUserId: input.revokedByUserId,
      })
      .where(
        and(
          eq(artifactShares.bundleId, bundleId),
          isNull(artifactShares.revokedAt),
        ),
      )
      .returning();
    return row ? toRecord(row) : null;
  }
}

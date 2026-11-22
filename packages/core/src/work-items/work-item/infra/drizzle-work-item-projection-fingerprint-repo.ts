import { and, eq } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { PersistenceError } from "@scarn/core/lib/errors";
import { workItemProjectionFingerprints } from "@scarn/core/lib/db/schema";
import type { WorkItemProjectionFingerprintRepo } from "../application/work-item-repo";
import { WorkItemProjectionFingerprintEntity } from "../domain/work-item-projection-fingerprint-entity";
import { parseWorkItemId, type WorkItemId } from "../domain/work-item-id";

export class DrizzleWorkItemProjectionFingerprintRepo
  implements WorkItemProjectionFingerprintRepo
{
  private toEntity(
    row: typeof workItemProjectionFingerprints.$inferSelect,
  ): WorkItemProjectionFingerprintEntity {
    return new WorkItemProjectionFingerprintEntity({
      workItemId: parseWorkItemId(row.workItemId),
      specId: row.specId,
      fingerprint: row.fingerprint,
      canonicalContent: row.canonicalContent,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  async load(
    workItemId: WorkItemId,
    specId: string,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemProjectionFingerprintEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(workItemProjectionFingerprints)
      .where(
        and(
          eq(workItemProjectionFingerprints.workItemId, workItemId),
          eq(workItemProjectionFingerprints.specId, specId),
        ),
      )
      .limit(1);

    return row ? this.toEntity(row) : null;
  }

  async save(
    fingerprint: WorkItemProjectionFingerprintEntity,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemProjectionFingerprintEntity> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .insert(workItemProjectionFingerprints)
      .values({
        workItemId: fingerprint.workItemId,
        specId: fingerprint.specId,
        fingerprint: fingerprint.fingerprint,
        canonicalContent: fingerprint.canonicalContent,
        createdAt: fingerprint.createdAt ?? new Date(),
        updatedAt: fingerprint.updatedAt ?? new Date(),
      })
      .onConflictDoUpdate({
        target: [
          workItemProjectionFingerprints.workItemId,
          workItemProjectionFingerprints.specId,
        ],
        set: {
          fingerprint: fingerprint.fingerprint,
          canonicalContent: fingerprint.canonicalContent,
          updatedAt: fingerprint.updatedAt ?? new Date(),
        },
      })
      .returning();

    if (!row) {
      throw new PersistenceError(
        `Failed to save work item projection fingerprint ${fingerprint.workItemId}:${fingerprint.specId}`,
        "WORK_ITEM_PROJECTION_FINGERPRINT_SAVE_FAILED",
      );
    }

    return this.toEntity(row);
  }
}

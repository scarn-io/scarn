import { and, eq, or } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { createUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { parseWorkItemId } from "@scarn/core/work-items/work-item/domain/work-item-id";
import { githubRelationshipPendingRefs } from "@scarn/core/lib/db/schema";
import type {
  GithubRelationshipPendingRef,
  GithubRelationshipPendingRefRepo,
} from "../application/github-relationship-pending-ref-repo";

const toRow = (ref: Omit<GithubRelationshipPendingRef, "id">) => ({
  id: createUuidV7(),
  projectId: ref.projectId,
  workItemId: ref.workItemId,
  kind: ref.kind,
  targetPlatformKey: ref.targetPlatformKey,
});

export class DrizzleGithubRelationshipPendingRefRepo implements GithubRelationshipPendingRefRepo {
  private toEntity(
    row: typeof githubRelationshipPendingRefs.$inferSelect,
  ): GithubRelationshipPendingRef {
    return {
      id: row.id as UuidV7,
      projectId: row.projectId as UuidV7,
      workItemId: parseWorkItemId(row.workItemId),
      kind: row.kind,
      targetPlatformKey: row.targetPlatformKey,
    };
  }

  async listByProjectId(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<GithubRelationshipPendingRef[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(githubRelationshipPendingRefs)
      .where(eq(githubRelationshipPendingRefs.projectId, projectId));

    return rows.map((row) => this.toEntity(row));
  }

  async upsertMany(
    refs: Array<Omit<GithubRelationshipPendingRef, "id">>,
    dbExecutor?: DbExecutor,
  ): Promise<void> {
    if (refs.length === 0) {
      return;
    }

    const db = dbExecutor ?? getDb();
    await db
      .insert(githubRelationshipPendingRefs)
      .values(refs.map((ref) => toRow(ref)))
      .onConflictDoNothing({
        target: [
          githubRelationshipPendingRefs.workItemId,
          githubRelationshipPendingRefs.kind,
          githubRelationshipPendingRefs.targetPlatformKey,
        ],
      });
  }

  async deleteMany(
    refs: Array<
      Pick<
        GithubRelationshipPendingRef,
        "workItemId" | "kind" | "targetPlatformKey"
      >
    >,
    dbExecutor?: DbExecutor,
  ): Promise<void> {
    if (refs.length === 0) {
      return;
    }

    const db = dbExecutor ?? getDb();
    await db
      .delete(githubRelationshipPendingRefs)
      .where(
        or(
          ...refs.map((ref) =>
            and(
              eq(githubRelationshipPendingRefs.workItemId, ref.workItemId),
              eq(githubRelationshipPendingRefs.kind, ref.kind),
              eq(
                githubRelationshipPendingRefs.targetPlatformKey,
                ref.targetPlatformKey,
              ),
            ),
          ),
        ),
      );
  }
}

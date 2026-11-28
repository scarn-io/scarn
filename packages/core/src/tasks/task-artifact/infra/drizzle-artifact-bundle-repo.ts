import { and, asc, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { taskArtifactBundles, taskArtifacts } from "@scarn/core/lib/db/schema";
import { isUniqueViolation } from "@scarn/core/lib/db/unique-violation";
import {
  PersistenceError,
  ResourceConflictError,
} from "@scarn/core/lib/errors";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { ArtifactContract } from "../contracts/task-artifact-contracts";
import type {
  ArtifactBundleRecord,
  ArtifactBundleRepo,
  CreateArtifactBundleRow,
  FinalizeArtifactBundleInput,
} from "../application/artifact-bundle-repo";
import { bundleMemberStorePath } from "../domain/artifact-bundle";
import { toArtifactContract } from "./drizzle-artifact-repo";

const DEFAULT_STALE_PENDING_LIMIT = 500;

const toRecord = (
  row: typeof taskArtifactBundles.$inferSelect,
): ArtifactBundleRecord => ({
  id: row.id as UuidV7,
  projectId: row.projectId as UuidV7,
  taskRunId: row.taskRunId as UuidV7,
  name: row.name,
  fieldPath: row.fieldPath,
  rootPath: row.rootPath,
  entryPath: row.entryPath,
  status: row.status,
  fileCount: row.fileCount,
  sizeBytes: row.sizeBytes,
  createdAt: row.createdAt.toISOString(),
  finalizedAt: row.finalizedAt?.toISOString() ?? null,
  expiredAt: row.expiredAt?.toISOString() ?? null,
  deletedAt: row.deletedAt?.toISOString() ?? null,
});

export class DrizzleArtifactBundleRepo implements ArtifactBundleRepo {
  async create(
    input: CreateArtifactBundleRow,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactBundleRecord> {
    const db = dbExecutor ?? getDb();
    let row: typeof taskArtifactBundles.$inferSelect | undefined;
    try {
      [row] = await db
        .insert(taskArtifactBundles)
        .values({
          id: input.id,
          projectId: input.projectId,
          taskRunId: input.taskRunId,
          name: input.name,
          fieldPath: input.fieldPath,
          rootPath: input.rootPath,
          entryPath: input.entryPath,
          status: "pending",
        })
        .returning();
    } catch (error) {
      if (isUniqueViolation(error as Error)) {
        throw new ResourceConflictError(
          "artifact bundle",
          `${input.taskRunId}/${input.name}`,
        );
      }
      throw error;
    }

    if (!row) {
      throw new PersistenceError(
        `Failed to create artifact bundle ${input.id}`,
        "ARTIFACT_BUNDLE_CREATE_FAILED",
      );
    }
    return toRecord(row);
  }

  async finalize(
    bundleId: UuidV7,
    input: FinalizeArtifactBundleInput,
    finalizedAt: Date,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactBundleRecord | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .update(taskArtifactBundles)
      .set({
        status: input.status,
        fileCount: input.fileCount ?? null,
        sizeBytes: input.sizeBytes ?? null,
        finalizedAt,
      })
      .where(
        and(
          eq(taskArtifactBundles.id, bundleId),
          eq(taskArtifactBundles.status, "pending"),
          isNull(taskArtifactBundles.deletedAt),
        ),
      )
      .returning();

    return row ? toRecord(row) : null;
  }

  async findById(
    bundleId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactBundleRecord | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(taskArtifactBundles)
      .where(
        and(
          eq(taskArtifactBundles.id, bundleId),
          isNull(taskArtifactBundles.deletedAt),
        ),
      )
      .limit(1);

    return row ? toRecord(row) : null;
  }

  async findByIdIncludingDeleted(
    bundleId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactBundleRecord | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(taskArtifactBundles)
      .where(eq(taskArtifactBundles.id, bundleId))
      .limit(1);

    return row ? toRecord(row) : null;
  }

  async findManyByIds(
    bundleIds: UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactBundleRecord[]> {
    if (bundleIds.length === 0) {
      return [];
    }
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(taskArtifactBundles)
      .where(
        and(
          inArray(taskArtifactBundles.id, bundleIds),
          isNull(taskArtifactBundles.deletedAt),
        ),
      )
      .orderBy(
        desc(taskArtifactBundles.createdAt),
        desc(taskArtifactBundles.id),
      );

    return rows.map(toRecord);
  }

  async listByTask(
    taskRunId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactBundleRecord[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(taskArtifactBundles)
      .where(
        and(
          eq(taskArtifactBundles.taskRunId, taskRunId),
          isNull(taskArtifactBundles.deletedAt),
        ),
      )
      .orderBy(
        desc(taskArtifactBundles.createdAt),
        desc(taskArtifactBundles.id),
      );

    return rows.map(toRecord);
  }

  async findMember(
    bundleId: UuidV7,
    path: string,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactContract | null> {
    const db = dbExecutor ?? getDb();
    const bundle = await this.findById(bundleId, db);
    if (!bundle) {
      return null;
    }

    const [row] = await db
      .select()
      .from(taskArtifacts)
      .where(
        and(
          eq(taskArtifacts.bundleId, bundleId),
          eq(
            taskArtifacts.relativeStorePath,
            bundleMemberStorePath(bundle.rootPath, path),
          ),
          isNull(taskArtifacts.deletedAt),
        ),
      )
      .orderBy(desc(taskArtifacts.createdAt))
      .limit(1);

    return row ? toArtifactContract(row) : null;
  }

  async listMembers(
    bundleId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactContract[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(taskArtifacts)
      .where(
        and(
          eq(taskArtifacts.bundleId, bundleId),
          isNull(taskArtifacts.deletedAt),
        ),
      )
      .orderBy(desc(taskArtifacts.createdAt), desc(taskArtifacts.id));

    return rows.map(toArtifactContract);
  }

  async listStalePending(
    olderThan: Date,
    limit = DEFAULT_STALE_PENDING_LIMIT,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactBundleRecord[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(taskArtifactBundles)
      .where(
        and(
          eq(taskArtifactBundles.status, "pending"),
          lt(taskArtifactBundles.createdAt, olderThan),
          isNull(taskArtifactBundles.deletedAt),
        ),
      )
      .orderBy(asc(taskArtifactBundles.createdAt))
      .limit(limit);

    return rows.map(toRecord);
  }
}

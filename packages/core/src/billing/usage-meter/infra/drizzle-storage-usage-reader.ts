import { and, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { projects, taskArtifacts, taskRuns } from "@scarn/core/lib/db/schema";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type {
  OrgRetainedBytes,
  OrgRetainedBytesBreakdown,
  StorageUsageReader,
} from "../application/storage-usage-reader";

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

/**
 * A saved agent session still present: it has an object key and its run
 * completed inside the retention window (the `tasks/` lifecycle rule ages it
 * from the upload, which happens just before the run completes).
 */
const retainedSession = (cutoff: Date) =>
  and(isNotNull(taskRuns.sessionObjectKey), gt(taskRuns.completedAt, cutoff));

export class DrizzleStorageUsageReader implements StorageUsageReader {
  async sumRetainedBytesByOrg(
    now: Date,
    retentionDays: number,
    dbExecutor?: DbExecutor,
    orgId?: UuidV7,
  ): Promise<OrgRetainedBytes[]> {
    const db = dbExecutor ?? getDb();
    const cutoff = new Date(now.getTime() - retentionDays * MS_PER_DAY);
    const inOrg = orgId === undefined ? undefined : eq(projects.orgId, orgId);

    // SUM(log_archive_size_bytes) GROUP BY owning org, over archives still
    // considered present. `bigint` columns surface as strings from pg
    // SUM, so COALESCE to 0 and cast at the boundary.
    const logRows = await db
      .select({
        orgId: projects.orgId,
        bytes: sql<string>`coalesce(sum(${taskRuns.logArchiveSizeBytes}), 0)`,
      })
      .from(taskRuns)
      .innerJoin(projects, eq(taskRuns.projectId, projects.id))
      .where(
        and(
          // Exclude null-org rows: we cannot attribute their bytes to a
          // billing org, and they would collapse into a bogus group.
          isNotNull(projects.orgId),
          inOrg,
          isNotNull(taskRuns.logArchiveStoreRef),
          // Present == not yet aged past the lifecycle window. Legacy rows with
          // no archived-at timestamp are treated as present (NULL), matching the
          // pre-timestamp behaviour; timestamped rows must be inside the window.
          or(
            isNull(taskRuns.logArchivedAt),
            gt(taskRuns.logArchivedAt, cutoff),
          ),
        ),
      )
      .groupBy(projects.orgId);

    // SUM(size_bytes) GROUP BY owning org, over artifacts still considered
    // present. `createdAt` is the artifact's aging anchor (set once at insert,
    // never rewritten), so present == has a store ref AND createdAt is inside
    // the retention window. Unlike the log-archive branch above, there is no
    // "legacy null timestamp" fallback here: every artifact row has always had
    // a `createdAt`, so a plain cutoff comparison is correct with no OR-null
    // branch needed.
    const artifactRows = await db
      .select({
        orgId: projects.orgId,
        bytes: sql<string>`coalesce(sum(${taskArtifacts.sizeBytes}), 0)`,
      })
      .from(taskArtifacts)
      .innerJoin(projects, eq(taskArtifacts.projectId, projects.id))
      .where(
        and(
          isNotNull(projects.orgId),
          inOrg,
          isNotNull(taskArtifacts.storeRef),
          gt(taskArtifacts.createdAt, cutoff),
        ),
      )
      .groupBy(projects.orgId);

    const sessionRows = await db
      .select({
        orgId: projects.orgId,
        bytes: sql<string>`coalesce(sum(${taskRuns.sessionSizeBytes}), 0)`,
      })
      .from(taskRuns)
      .innerJoin(projects, eq(taskRuns.projectId, projects.id))
      .where(and(isNotNull(projects.orgId), inOrg, retainedSession(cutoff)))
      .groupBy(projects.orgId);

    // Merge the per-org sums: an org may appear in any subset of the lists.
    // Union the org ids and add the byte totals, defaulting a missing side to
    // 0. `isNotNull(projects.orgId)` in every WHERE clause guarantees every
    // grouped row carries a non-null org id, so no runtime null guard is
    // needed here.
    const totalBytesByOrgId = new Map<string, number>();
    for (const row of [...logRows, ...artifactRows, ...sessionRows]) {
      const previous = totalBytesByOrgId.get(row.orgId) ?? 0;
      totalBytesByOrgId.set(row.orgId, previous + Number(row.bytes));
    }

    return Array.from(
      totalBytesByOrgId,
      ([orgId, bytes]): OrgRetainedBytes => ({
        orgId: parseUuidV7(orgId),
        bytes,
      }),
    );
  }

  async getRetainedBytesBreakdownForOrg(
    orgId: UuidV7,
    now: Date,
    retentionDays: number,
    dbExecutor?: DbExecutor,
  ): Promise<OrgRetainedBytesBreakdown> {
    const db = dbExecutor ?? getDb();
    const cutoff = new Date(now.getTime() - retentionDays * MS_PER_DAY);

    // Same "present" predicates as `sumRetainedBytesByOrg` above, scoped to a
    // single org via `eq(projects.orgId, orgId)` instead of grouped across
    // every org. Kept as two separate scalar sums (rather than one query with
    // a `FILTER` clause) so each branch reads identically to its
    // whole-table counterpart above and the two predicates can't drift.
    const [logRow] = await db
      .select({
        bytes: sql<string>`coalesce(sum(${taskRuns.logArchiveSizeBytes}), 0)`,
      })
      .from(taskRuns)
      .innerJoin(projects, eq(taskRuns.projectId, projects.id))
      .where(
        and(
          eq(projects.orgId, orgId),
          isNotNull(taskRuns.logArchiveStoreRef),
          or(
            isNull(taskRuns.logArchivedAt),
            gt(taskRuns.logArchivedAt, cutoff),
          ),
        ),
      );

    const [artifactRow] = await db
      .select({
        bytes: sql<string>`coalesce(sum(${taskArtifacts.sizeBytes}), 0)`,
      })
      .from(taskArtifacts)
      .innerJoin(projects, eq(taskArtifacts.projectId, projects.id))
      .where(
        and(
          eq(projects.orgId, orgId),
          isNotNull(taskArtifacts.storeRef),
          gt(taskArtifacts.createdAt, cutoff),
        ),
      );

    const [sessionRow] = await db
      .select({
        bytes: sql<string>`coalesce(sum(${taskRuns.sessionSizeBytes}), 0)`,
      })
      .from(taskRuns)
      .innerJoin(projects, eq(taskRuns.projectId, projects.id))
      .where(and(eq(projects.orgId, orgId), retainedSession(cutoff)));

    return {
      artifactBytes: Number(artifactRow?.bytes ?? 0),
      logBytes: Number(logRow?.bytes ?? 0),
      sessionBytes: Number(sessionRow?.bytes ?? 0),
    };
  }
}

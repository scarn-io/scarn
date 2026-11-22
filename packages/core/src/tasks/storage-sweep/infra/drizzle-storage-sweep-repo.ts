import { asc, eq, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { storageSweeps } from "@scarn/core/lib/db/schema";
import {
  createUuidV7,
  parseUuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import type { StorageSweepRepo } from "../application/storage-sweep-repo";
import type { StorageSweep, SweptRun } from "../domain/storage-sweep";

type StorageSweepRow = typeof storageSweeps.$inferSelect;

const toStorageSweep = (row: StorageSweepRow): StorageSweep => ({
  id: parseUuidV7(row.id),
  projectId: parseUuidV7(row.projectId),
  taskRunId: parseUuidV7(row.taskRunId),
  notBefore: row.notBefore,
  attempts: row.attempts,
  lastError: row.lastError,
  createdAt: row.createdAt,
});

export class DrizzleStorageSweepRepo implements StorageSweepRepo {
  async schedule(
    runs: SweptRun[],
    input: { notBefore: Date; createdAt: Date },
    dbExecutor: DbExecutor,
  ): Promise<void> {
    if (runs.length === 0) {
      return;
    }
    await dbExecutor.insert(storageSweeps).values(
      runs.map((run) => ({
        id: createUuidV7(),
        projectId: run.projectId,
        taskRunId: run.taskRunId,
        notBefore: input.notBefore,
        createdAt: input.createdAt,
      })),
    );
  }

  async claimDue(
    input: { now: Date; leaseUntil: Date; limit: number },
    dbExecutor?: DbExecutor,
  ): Promise<StorageSweep[]> {
    const db = dbExecutor ?? getDb();
    const due = db
      .select({ id: storageSweeps.id })
      .from(storageSweeps)
      .where(lte(storageSweeps.notBefore, input.now))
      .orderBy(asc(storageSweeps.notBefore), asc(storageSweeps.id))
      .limit(input.limit)
      .for("update", { skipLocked: true });
    const rows = await db
      .update(storageSweeps)
      .set({ notBefore: input.leaseUntil })
      .where(inArray(storageSweeps.id, due))
      .returning();
    return rows.map(toStorageSweep);
  }

  async complete(
    id: StorageSweep["id"],
    dbExecutor?: DbExecutor,
  ): Promise<void> {
    const db = dbExecutor ?? getDb();
    await db.delete(storageSweeps).where(eq(storageSweeps.id, id));
  }

  async recordFailure(
    id: StorageSweep["id"],
    input: { attempts: number; lastError: string; notBefore: Date },
    dbExecutor?: DbExecutor,
  ): Promise<void> {
    const db = dbExecutor ?? getDb();
    await db
      .update(storageSweeps)
      .set({
        attempts: input.attempts,
        lastError: input.lastError,
        notBefore: input.notBefore,
      })
      .where(eq(storageSweeps.id, id));
  }

  async countOverdue(
    input: { createdBefore: Date; minAttempts: number },
    dbExecutor?: DbExecutor,
  ): Promise<number> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(storageSweeps)
      .where(
        or(
          lt(storageSweeps.createdAt, input.createdBefore),
          gte(storageSweeps.attempts, input.minAttempts),
        ),
      );
    return row?.count ?? 0;
  }
}

import { and, eq, ne, notInArray, sql } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { usageMeters } from "@scarn/core/lib/db/schema";
import { PersistenceError } from "@scarn/core/lib/errors";
import { type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { PlanId } from "@scarn/core/billing/plan/contracts/plan-contracts";
import type { OrgRetainedBytes } from "../application/storage-usage-reader";
import type { UsageMeterRepo } from "../application/usage-meter-repo";
import { UsageMeter, type UsageMeterProps } from "../domain/usage-meter-entity";

type UsageMeterRow = typeof usageMeters.$inferSelect;

const toRow = (meter: UsageMeter) => {
  const props = meter.toJSON();
  return {
    orgId: props.orgId,
    period: props.period,
    planId: props.planId,
    writes: props.writes,
    reads: props.reads,
    storageBytes: props.storageBytes,
    signalTokens: props.signalTokens,
  };
};

export class DrizzleUsageMeterRepo implements UsageMeterRepo {
  private toEntity(row: UsageMeterRow): UsageMeter {
    return UsageMeter.rehydrate({
      orgId: row.orgId as UsageMeterProps["orgId"],
      period: row.period,
      planId: row.planId as PlanId,
      writes: row.writes,
      reads: row.reads,
      storageBytes: row.storageBytes,
      signalTokens: row.signalTokens,
    });
  }

  async loadForPeriod(
    orgId: UuidV7,
    period: string,
    dbExecutor?: DbExecutor,
  ): Promise<UsageMeter | null> {
    const db = dbExecutor ?? getDb();
    const baseQuery = db
      .select()
      .from(usageMeters)
      .where(and(eq(usageMeters.orgId, orgId), eq(usageMeters.period, period)))
      .limit(1);

    // Lock the row only when running inside a caller-provided transaction.
    // Outside a tx, `FOR UPDATE` releases the lock immediately on the implicit
    // commit, so it buys nothing and the plain read is correct.
    const rows = dbExecutor ? await baseQuery.for("update") : await baseQuery;
    const [row] = rows;

    return row ? this.toEntity(row) : null;
  }

  async loadOrStart(
    orgId: UuidV7,
    period: string,
    planId: PlanId,
    dbExecutor?: DbExecutor,
  ): Promise<UsageMeter> {
    const existing = await this.loadForPeriod(orgId, period, dbExecutor);
    return existing ?? UsageMeter.startPeriod(orgId, period, planId);
  }

  async save(meter: UsageMeter, dbExecutor?: DbExecutor): Promise<UsageMeter> {
    const db = dbExecutor ?? getDb();
    const row = toRow(meter);

    // Atomic upsert on the (org_id, period) unique index. The entity holds
    // ABSOLUTE counts (Phase 2 is read-modify-write at the entity level), so the
    // upsert writes those absolutes rather than incrementing in SQL. See the
    // class doc for the concurrency caveat.
    const [savedRow] = await db
      .insert(usageMeters)
      .values(row)
      .onConflictDoUpdate({
        target: [usageMeters.orgId, usageMeters.period],
        set: {
          planId: row.planId,
          writes: row.writes,
          reads: row.reads,
          storageBytes: row.storageBytes,
          signalTokens: row.signalTokens,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (!savedRow) {
      throw new PersistenceError(
        `Failed to save usage meter for org ${meter.orgId} period ${meter.period}`,
        "USAGE_METER_SAVE_FAILED",
      );
    }

    return this.toEntity(savedRow);
  }

  async reconcileStorageForPeriod(
    period: string,
    retainedByOrg: OrgRetainedBytes[],
    defaultPlanId: PlanId,
    dbExecutor?: DbExecutor,
    orgId?: UuidV7,
  ): Promise<number> {
    const db = dbExecutor ?? getDb();
    const now = new Date();

    // Statement 1: floor `storage_bytes` to 0 for every meter row in the period
    // that is NOT in the retained set. This zeroes orgs whose archives all
    // expired (the source-of-truth sum omits them) without enumerating them
    // first. The `ne(storageBytes, 0)` guard avoids no-op writes/`updated_at`
    // churn on rows already at zero. Other counters are left untouched.
    const retainedOrgIds = retainedByOrg.map((row) => row.orgId);
    const flooredRows = await db
      .update(usageMeters)
      .set({ storageBytes: 0, updatedAt: now })
      .where(
        and(
          eq(usageMeters.period, period),
          ne(usageMeters.storageBytes, 0),
          ...(orgId === undefined ? [] : [eq(usageMeters.orgId, orgId)]),
          ...(retainedOrgIds.length > 0
            ? [notInArray(usageMeters.orgId, retainedOrgIds)]
            : []),
        ),
      )
      .returning({ orgId: usageMeters.orgId });

    if (retainedByOrg.length === 0) {
      return flooredRows.length;
    }

    // Statement 2: SET `storage_bytes` to the recomputed absolute total for each
    // retained org via a single multi-row upsert on the (org_id, period) unique
    // index. Existing rows keep their `writes`/`reads`/`signal_tokens`; brand-new rows start
    // them at the column defaults (0). Mirrors the absolute-value upsert idiom
    // in `save()`.
    const values = retainedByOrg.map((row) => ({
      orgId: row.orgId,
      period,
      planId: defaultPlanId,
      storageBytes: row.bytes,
    }));

    const upsertedRows = await db
      .insert(usageMeters)
      .values(values)
      .onConflictDoUpdate({
        target: [usageMeters.orgId, usageMeters.period],
        set: {
          storageBytes: sql`excluded.storage_bytes`,
          updatedAt: now,
        },
      })
      .returning({ orgId: usageMeters.orgId });

    return flooredRows.length + upsertedRows.length;
  }
}

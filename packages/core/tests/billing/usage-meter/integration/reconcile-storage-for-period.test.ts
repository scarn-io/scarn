import { randomInt } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "bun:test";
import { v7 as uuidv7 } from "uuid";
import { getDb } from "@/lib/db";
import { usageMeters } from "@/lib/db/schema";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { DrizzleUsageMeterRepo } from "@/billing/usage-meter/infra/drizzle-usage-meter-repo";
import type { OrgRetainedBytes } from "@/billing/usage-meter/application/storage-usage-reader";

/**
 * Integration coverage for the set-based storage reconciliation primitive
 * `DrizzleUsageMeterRepo.reconcileStorageForPeriod`, which replaced the former
 * per-org read-modify-write loop. Asserts it (a) SETS retained totals, (b)
 * floors expired-only orgs to 0, (c) leaves `writes`/`reads`/`signalTokens`
 * untouched, and (d) inserts a row for an org that retains bytes but has no
 * meter yet. Also covers the `signalTokens` save/load round-trip.
 *
 * `reconcileStorageForPeriod` operates on every row in a given period, not
 * just the orgs a test creates, so each test's period must contain nothing
 * but the rows that test itself seeds — the test database's Postgres
 * container is shared and reused across local `bun test` invocations (see
 * @scarn/local-dev/test-db), so it is never guaranteed to start empty. A
 * random year (any 4-digit value is valid per `PERIOD_PATTERN`/`periodSchema`) makes
 * collisions with a previous run's leftover rows unlikely, but this
 * container has been reused for long enough that "unlikely" still happens
 * in practice — `clearPeriod` below deletes any such leftovers up front so
 * each test is deterministically isolated regardless of the container's
 * history.
 */
const YEAR = String(randomInt(2100, 3000));

describe("DrizzleUsageMeterRepo.reconcileStorageForPeriod", () => {
  const repo = new DrizzleUsageMeterRepo();

  const clearPeriod = async (period: string) => {
    await getDb().delete(usageMeters).where(eq(usageMeters.period, period));
  };

  const seedMeter = async (row: {
    orgId: string;
    period: string;
    writes?: number;
    reads?: number;
    storageBytes: number;
    signalTokens?: number;
  }) => {
    await getDb()
      .insert(usageMeters)
      .values({
        orgId: row.orgId,
        period: row.period,
        planId: "free",
        writes: row.writes ?? 0,
        reads: row.reads ?? 0,
        storageBytes: row.storageBytes,
        signalTokens: row.signalTokens ?? 0,
      });
  };

  const readMeter = async (orgId: string, period: string) => {
    const [meter] = await getDb()
      .select()
      .from(usageMeters)
      .where(and(eq(usageMeters.orgId, orgId), eq(usageMeters.period, period)));
    return meter;
  };

  test("sets each retained org's storageBytes to the recomputed total", async () => {
    const period = `${YEAR}-01`;
    await clearPeriod(period);
    const orgA = uuidv7();
    const orgB = uuidv7();
    await seedMeter({ orgId: orgA, period, storageBytes: 100 });
    await seedMeter({ orgId: orgB, period, storageBytes: 999 });

    const retained: OrgRetainedBytes[] = [
      { orgId: parseUuidV7(orgA), bytes: 512 },
      { orgId: parseUuidV7(orgB), bytes: 0 },
    ];

    const count = await repo.reconcileStorageForPeriod(
      period,
      retained,
      "free",
    );

    expect(count).toBe(2);
    expect((await readMeter(orgA, period))?.storageBytes).toBe(512);
    expect((await readMeter(orgB, period))?.storageBytes).toBe(0);
  });

  test("floors expired-only orgs (absent from the retained set) to zero", async () => {
    const period = `${YEAR}-02`;
    await clearPeriod(period);
    const retainedOrg = uuidv7();
    const expiredOrg = uuidv7();
    await seedMeter({ orgId: retainedOrg, period, storageBytes: 10 });
    await seedMeter({ orgId: expiredOrg, period, storageBytes: 4096 });

    const retained: OrgRetainedBytes[] = [
      { orgId: parseUuidV7(retainedOrg), bytes: 64 },
    ];

    const count = await repo.reconcileStorageForPeriod(
      period,
      retained,
      "free",
    );

    // 1 set + 1 floored.
    expect(count).toBe(2);
    expect((await readMeter(retainedOrg, period))?.storageBytes).toBe(64);
    expect((await readMeter(expiredOrg, period))?.storageBytes).toBe(0);
  });

  test("preserves writes/reads/signalTokens while overwriting storageBytes", async () => {
    const period = `${YEAR}-03`;
    await clearPeriod(period);
    const orgId = uuidv7();
    await seedMeter({
      orgId,
      period,
      writes: 7,
      reads: 13,
      storageBytes: 100,
      signalTokens: 21,
    });

    await repo.reconcileStorageForPeriod(
      period,
      [{ orgId: parseUuidV7(orgId), bytes: 200 }],
      "free",
    );

    const meter = await readMeter(orgId, period);
    expect(meter?.storageBytes).toBe(200);
    expect(meter?.writes).toBe(7);
    expect(meter?.reads).toBe(13);
    expect(meter?.signalTokens).toBe(21);
  });

  test("inserts a meter row for an org that retains bytes but has none yet", async () => {
    const period = `${YEAR}-04`;
    await clearPeriod(period);
    const newOrg = uuidv7();

    const count = await repo.reconcileStorageForPeriod(
      period,
      [{ orgId: parseUuidV7(newOrg), bytes: 333 }],
      "free",
    );

    expect(count).toBe(1);
    const meter = await readMeter(newOrg, period);
    expect(meter?.storageBytes).toBe(333);
    expect(meter?.writes).toBe(0);
    expect(meter?.reads).toBe(0);
    expect(meter?.planId).toBe("free");
  });

  test("no retained orgs floors all rows in the period to zero", async () => {
    const period = `${YEAR}-05`;
    await clearPeriod(period);
    const orgA = uuidv7();
    const orgB = uuidv7();
    await seedMeter({ orgId: orgA, period, storageBytes: 50 });
    await seedMeter({
      orgId: orgB,
      period,
      writes: 3,
      storageBytes: 75,
      signalTokens: 5,
    });

    const count = await repo.reconcileStorageForPeriod(period, [], "free");

    expect(count).toBe(2);
    expect((await readMeter(orgA, period))?.storageBytes).toBe(0);
    const meterB = await readMeter(orgB, period);
    expect(meterB?.storageBytes).toBe(0);
    expect(meterB?.writes).toBe(3);
    expect(meterB?.signalTokens).toBe(5);
  });

  test("save/loadForPeriod round-trip signalTokens", async () => {
    const period = `${YEAR}-06`;
    await clearPeriod(period);
    const orgId = parseUuidV7(uuidv7());

    const started = await repo.loadOrStart(orgId, period, "free");
    expect(started.signalTokens).toBe(0);

    const saved = await repo.save(
      started.recordSignalToken().recordSignalToken(),
    );
    expect(saved.signalTokens).toBe(2);

    const loaded = await repo.loadOrStart(orgId, period, "free");
    expect(loaded.signalTokens).toBe(2);
    expect(loaded.writes).toBe(0);
    expect(loaded.reads).toBe(0);
    expect((await readMeter(orgId, period))?.signalTokens).toBe(2);
  });
});

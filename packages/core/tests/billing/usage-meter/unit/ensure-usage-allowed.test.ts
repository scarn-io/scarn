import { describe, expect } from "bun:test";
import { serialTest, fixedTimeProvider } from "tests/utils";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import type { PlanId } from "@/billing/plan/contracts/plan-contracts";
import { PLAN_LIMITS_CONFIG } from "@/billing/plan/domain/plan-limits";
import { UsageMeter } from "@/billing/usage-meter/domain/usage-meter-entity";
import { ensureUsageAllowed } from "@/billing/usage-meter/application/ensure-usage-allowed";
import type { UsageMeterRepo } from "@/billing/usage-meter/application/usage-meter-repo";
import { UsageLimitExceededError } from "@/lib/errors";

const NOW = new Date("2026-06-15T12:00:00.000Z");
const PERIOD = "2026-06";
const FREE_WRITE_CAP = PLAN_LIMITS_CONFIG.free.maxWritesPerMonth;

/**
 * A repo with no persisted row: `loadOrStart` starts a meter on whichever plan
 * the caller passes, pre-filled to `writes`, and records that plan.
 */
const freshPeriodRepo = (orgId: UuidV7, writes: number) => {
  const requestedPlans: PlanId[] = [];
  const repo: UsageMeterRepo = {
    loadForPeriod: () => Promise.resolve(null),
    loadOrStart: (_orgId, _period, planId) => {
      requestedPlans.push(planId);
      return Promise.resolve(
        UsageMeter.rehydrate({
          orgId,
          period: PERIOD,
          planId,
          writes,
          reads: 0,
          storageBytes: 0,
          signalTokens: 0,
        }),
      );
    },
    save: (meter) => Promise.resolve(meter),
    reconcileStorageForPeriod: () => Promise.resolve(0),
  };
  return { repo, requestedPlans };
};

/**
 * Runs the guard with `SCARN_DEFAULT_PLAN` set to `plan` (or unset). The plan
 * is read synchronously before the guard's first await, so the env is
 * restored before any other test can observe it.
 */
const runWithDefaultPlan = (
  plan: string | undefined,
  run: () => ReturnType<typeof ensureUsageAllowed>,
) => {
  const previous = process.env["SCARN_DEFAULT_PLAN"];
  if (plan === undefined) delete process.env["SCARN_DEFAULT_PLAN"];
  else process.env["SCARN_DEFAULT_PLAN"] = plan;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env["SCARN_DEFAULT_PLAN"];
    else process.env["SCARN_DEFAULT_PLAN"] = previous;
  }
};

describe("ensureUsageAllowed default plan", () => {
  serialTest(
    "without SCARN_DEFAULT_PLAN a new meter is unlimited and allows past the free caps while still metering",
    async () => {
      const orgId = createUuidV7();
      const { repo, requestedPlans } = freshPeriodRepo(
        orgId,
        FREE_WRITE_CAP * 5,
      );
      const deps = {
        usageMeterRepo: repo,
        timeProvider: fixedTimeProvider(NOW),
      };

      const result = await runWithDefaultPlan(undefined, () =>
        ensureUsageAllowed(orgId, "write", { addBytes: 1024 ** 4 }, deps),
      );

      expect(requestedPlans).toEqual(["unlimited"]);
      expect(result.ok).toBe(true);

      const meter = await repo.loadOrStart(orgId, PERIOD, "unlimited");
      const next = meter.recordWrite().recordBytes(1024);
      expect(next.writes).toBe(FREE_WRITE_CAP * 5 + 1);
      expect(next.storageBytes).toBe(1024);
      expect(next.limitReached).toBeNull();
    },
  );

  serialTest(
    "with SCARN_DEFAULT_PLAN=free a new meter blocks at the free write cap",
    async () => {
      const orgId = createUuidV7();
      const { repo, requestedPlans } = freshPeriodRepo(orgId, FREE_WRITE_CAP);
      const deps = {
        usageMeterRepo: repo,
        timeProvider: fixedTimeProvider(NOW),
      };

      const result = await runWithDefaultPlan("free", () =>
        ensureUsageAllowed(orgId, "write", {}, deps),
      );

      expect(requestedPlans).toEqual(["free"]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(UsageLimitExceededError);
        expect(result.error.kind).toBe("write");
      }
    },
  );
});

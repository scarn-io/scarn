import { PlanLimits } from "@scarn/core/billing/plan/domain/plan-limits";
import {
  usageMeterSchema,
  type UsageMeterContract,
  type UsageStorageBreakdownContract,
} from "../contracts/usage-meter-contracts";
import { nextPeriodStart } from "../domain/billing-period";
import type { UsageMeter } from "../domain/usage-meter-entity";

/**
 * Audit timestamps for a usage meter. `UsageMeter` (Phase 2) is intentionally
 * timestamp-free — `createdAt`/`updatedAt` are persistence concerns owned by the
 * `app.usage_meters` row (DB-managed `defaultNow()`/`$onUpdate`). The mapper
 * therefore accepts them explicitly rather than reading them off the domain
 * entity, which is how every other aggregate's mapper sources timestamps (those
 * entities simply happen to carry their own). The repo passes the row values; a
 * not-yet-persisted meter (`loadOrStart` miss) uses the current time.
 */
export type UsageMeterTimestamps = {
  createdAt: Date;
  updatedAt: Date;
};

export const usageMeterEntityToContract = (
  meter: UsageMeter,
  timestamps: UsageMeterTimestamps,
  storageBreakdown: UsageStorageBreakdownContract,
): UsageMeterContract =>
  usageMeterSchema.parse({
    orgId: meter.orgId,
    period: meter.period,
    planId: meter.planId,
    writes: meter.writes,
    reads: meter.reads,
    signalTokens: meter.signalTokens,
    storageBytes: meter.storageBytes,
    storageBreakdown,
    limits: PlanLimits.for(meter.planId).toJSON(),
    resetsAt: nextPeriodStart(meter.period).toISOString(),
    createdAt: timestamps.createdAt.toISOString(),
    updatedAt: timestamps.updatedAt.toISOString(),
  });

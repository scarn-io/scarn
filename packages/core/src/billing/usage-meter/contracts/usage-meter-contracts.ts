import { z } from "zod";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { planIdSchema } from "@scarn/core/billing/plan/contracts/plan-contracts";

const periodSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Period must be "YYYY-MM"');

const usageCountSchema = z.number().int().nonnegative();

/** A plan cap; `null` means the plan has no cap for this metric. */
const usageCapSchema = usageCountSchema.nullable();

export const usageLimitsSchema = z.object({
  maxWritesPerMonth: usageCapSchema,
  maxReadsPerMonth: usageCapSchema,
  maxStorageBytes: usageCapSchema,
  maxSignalTokensPerMonth: usageCapSchema,
});

/**
 * Live split of `storageBytes` by source (artifacts, archived task logs and
 * saved agent sessions), computed at read time from the same source-of-truth
 * tables the reconciliation job sums (`StorageUsageReader`).
 * `artifactBytes + logBytes + sessionBytes`
 * should equal `storageBytes` in the common case, but this is NOT guaranteed
 * byte-for-byte: `storageBytes` is a persisted running counter updated inside
 * each write/delete request, while this breakdown is recomputed live on every
 * read, so the two can differ for a brief window (e.g. between an S3
 * lifecycle expiry and the next daily reconciliation sweep). Treat this as an
 * explanatory snapshot, not an audited total.
 */
export const usageStorageBreakdownSchema = z.object({
  artifactBytes: usageCountSchema,
  logBytes: usageCountSchema,
  sessionBytes: usageCountSchema,
});

export const usageMeterSchema = z.object({
  orgId: uuidV7Schema,
  period: periodSchema,
  planId: planIdSchema,
  writes: usageCountSchema,
  reads: usageCountSchema,
  signalTokens: usageCountSchema,
  storageBytes: usageCountSchema,
  storageBreakdown: usageStorageBreakdownSchema,
  limits: usageLimitsSchema,
  resetsAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type UsageLimitsContract = z.infer<typeof usageLimitsSchema>;

export type UsageStorageBreakdownContract = z.infer<
  typeof usageStorageBreakdownSchema
>;

export type UsageMeterContract = z.infer<typeof usageMeterSchema>;

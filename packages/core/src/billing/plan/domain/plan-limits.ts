import { CoreValidationError } from "@scarn/core/lib/errors";
import type { PlanId } from "@scarn/core/billing/plan/contracts/plan-contracts";

export type { PlanId };

/** A per-month (or retained, for storage) cap. `null` means no cap. */
export type PlanCap = number | null;

export type PlanLimitsProps = {
  maxWritesPerMonth: PlanCap;
  maxReadsPerMonth: PlanCap;
  maxStorageBytes: PlanCap;
  maxSignalTokensPerMonth: PlanCap;
};

const GIB = 1024 ** 3;

/**
 * Plan caps as data, not scattered constants. Adding a plan is a single
 * entry in this frozen map plus a value in {@link PlanId}. The `unlimited`
 * plan is the self-hosted default: usage is still metered, but nothing is
 * capped.
 */
export const PLAN_LIMITS_CONFIG = Object.freeze({
  free: Object.freeze({
    maxWritesPerMonth: 1000,
    maxReadsPerMonth: 3000,
    maxStorageBytes: GIB / 4,
    maxSignalTokensPerMonth: 7_500,
  }),
  unlimited: Object.freeze({
    maxWritesPerMonth: null,
    maxReadsPerMonth: null,
    maxStorageBytes: null,
    maxSignalTokensPerMonth: null,
  }),
}) satisfies Readonly<Record<PlanId, PlanLimitsProps>>;

const isUnder = (current: number, cap: PlanCap): boolean =>
  cap === null || current < cap;

const hasReached = (current: number, cap: PlanCap): boolean =>
  cap !== null && current >= cap;

/**
 * Value object holding the per-month caps for a plan. The cap math lives here so
 * callers never re-derive limit comparisons.
 */
export class PlanLimits {
  public readonly maxWritesPerMonth: PlanCap;
  public readonly maxReadsPerMonth: PlanCap;
  public readonly maxStorageBytes: PlanCap;
  public readonly maxSignalTokensPerMonth: PlanCap;

  private constructor(props: PlanLimitsProps) {
    this.maxWritesPerMonth = props.maxWritesPerMonth;
    this.maxReadsPerMonth = props.maxReadsPerMonth;
    this.maxStorageBytes = props.maxStorageBytes;
    this.maxSignalTokensPerMonth = props.maxSignalTokensPerMonth;
  }

  static for(planId: PlanId): PlanLimits {
    if (!Object.hasOwn(PLAN_LIMITS_CONFIG, planId)) {
      throw new CoreValidationError(
        `Unknown plan id: ${planId}`,
        "UNKNOWN_PLAN_ID",
      );
    }

    return new PlanLimits(PLAN_LIMITS_CONFIG[planId]);
  }

  allowsWrite(currentWrites: number): boolean {
    return isUnder(currentWrites, this.maxWritesPerMonth);
  }

  allowsRead(currentReads: number): boolean {
    return isUnder(currentReads, this.maxReadsPerMonth);
  }

  allowsBytes(currentBytes: number, addBytes: number): boolean {
    return (
      this.maxStorageBytes === null ||
      currentBytes + addBytes <= this.maxStorageBytes
    );
  }

  allowsSignalToken(currentSignalTokens: number): boolean {
    return isUnder(currentSignalTokens, this.maxSignalTokensPerMonth);
  }

  reachedWrites(writes: number): boolean {
    return hasReached(writes, this.maxWritesPerMonth);
  }

  reachedReads(reads: number): boolean {
    return hasReached(reads, this.maxReadsPerMonth);
  }

  reachedSignalTokens(signalTokens: number): boolean {
    return hasReached(signalTokens, this.maxSignalTokensPerMonth);
  }

  reachedStorage(storageBytes: number): boolean {
    return hasReached(storageBytes, this.maxStorageBytes);
  }

  toJSON(): PlanLimitsProps {
    return {
      maxWritesPerMonth: this.maxWritesPerMonth,
      maxReadsPerMonth: this.maxReadsPerMonth,
      maxStorageBytes: this.maxStorageBytes,
      maxSignalTokensPerMonth: this.maxSignalTokensPerMonth,
    };
  }
}

import { describe, expect } from "bun:test";
import { PlanLimits, type PlanId } from "@/billing/plan/domain/plan-limits";
import { CoreValidationError } from "@/lib/errors";
import { concurrentTest } from "tests/utils";

const GIB = 1024 ** 3;

describe("plan limits", () => {
  concurrentTest("exposes the free plan caps as data", () => {
    const limits = PlanLimits.for("free");

    expect(limits.maxWritesPerMonth).toBe(1000);
    expect(limits.maxReadsPerMonth).toBe(3000);
    expect(limits.maxStorageBytes).toBe(268435456);
    expect(limits.maxStorageBytes).toBe(GIB / 4);
    expect(limits.maxSignalTokensPerMonth).toBe(7_500);
    expect(limits.toJSON().maxSignalTokensPerMonth).toBe(7_500);
  });

  concurrentTest(
    "allowsSignalToken is true below the cap and false at/over it",
    () => {
      const limits = PlanLimits.for("free");

      expect(limits.allowsSignalToken(0)).toBe(true);
      expect(limits.allowsSignalToken(7_499)).toBe(true);
      expect(limits.allowsSignalToken(7_500)).toBe(false);
      expect(limits.allowsSignalToken(7_501)).toBe(false);
    },
  );

  concurrentTest(
    "allowsWrite is true below the cap and false at/over it",
    () => {
      const limits = PlanLimits.for("free");

      expect(limits.allowsWrite(0)).toBe(true);
      expect(limits.allowsWrite(999)).toBe(true);
      expect(limits.allowsWrite(1000)).toBe(false);
      expect(limits.allowsWrite(1001)).toBe(false);
    },
  );

  concurrentTest(
    "allowsRead is true below the cap and false at/over it",
    () => {
      const limits = PlanLimits.for("free");

      expect(limits.allowsRead(0)).toBe(true);
      expect(limits.allowsRead(2999)).toBe(true);
      expect(limits.allowsRead(3000)).toBe(false);
      expect(limits.allowsRead(3001)).toBe(false);
    },
  );

  concurrentTest(
    "allowsBytes is true when the sum stays within the cap",
    () => {
      const limits = PlanLimits.for("free");

      expect(limits.allowsBytes(0, 0)).toBe(true);
      expect(limits.allowsBytes(0, GIB / 4)).toBe(true);
      expect(limits.allowsBytes(GIB / 4 - 1, 1)).toBe(true);
      expect(limits.allowsBytes(GIB / 4, 0)).toBe(true);
    },
  );

  concurrentTest("allowsBytes is false when the sum exceeds the cap", () => {
    const limits = PlanLimits.for("free");

    expect(limits.allowsBytes(GIB / 4, 1)).toBe(false);
    expect(limits.allowsBytes(GIB / 4 - 1, 2)).toBe(false);
    expect(limits.allowsBytes(0, GIB / 4 + 1)).toBe(false);
  });

  concurrentTest("throws CoreValidationError for an unknown plan id", () => {
    expect(() => PlanLimits.for("enterprise" as PlanId)).toThrow(
      CoreValidationError,
    );

    try {
      PlanLimits.for("enterprise" as PlanId);
      throw new Error("expected PlanLimits.for to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CoreValidationError);
      expect((error as CoreValidationError).code).toBe("UNKNOWN_PLAN_ID");
    }
  });
});

describe("unlimited plan limits", () => {
  concurrentTest("has no caps and serializes them as null", () => {
    const limits = PlanLimits.for("unlimited");

    expect(limits.toJSON()).toEqual({
      maxWritesPerMonth: null,
      maxReadsPerMonth: null,
      maxStorageBytes: null,
      maxSignalTokensPerMonth: null,
    });
  });

  concurrentTest("never blocks and never reports a reached cap", () => {
    const limits = PlanLimits.for("unlimited");
    const huge = Number.MAX_SAFE_INTEGER;

    expect(limits.allowsWrite(huge)).toBe(true);
    expect(limits.allowsRead(huge)).toBe(true);
    expect(limits.allowsSignalToken(huge)).toBe(true);
    expect(limits.allowsBytes(huge, GIB)).toBe(true);
    expect(limits.reachedWrites(huge)).toBe(false);
    expect(limits.reachedReads(huge)).toBe(false);
    expect(limits.reachedSignalTokens(huge)).toBe(false);
    expect(limits.reachedStorage(huge)).toBe(false);
  });
});

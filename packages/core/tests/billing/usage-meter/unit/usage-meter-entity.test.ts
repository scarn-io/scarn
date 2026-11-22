import { describe, expect } from "bun:test";
import { UsageMeter } from "@/billing/usage-meter/domain/usage-meter-entity";
import { PLAN_LIMITS_CONFIG } from "@/billing/plan/domain/plan-limits";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { CoreValidationError, UsageLimitExceededError } from "@/lib/errors";
import { concurrentTest } from "tests/utils";

const FREE_STORAGE_CAP = PLAN_LIMITS_CONFIG.free.maxStorageBytes;

describe("usage meter entity", () => {
  concurrentTest("startPeriod yields a zeroed meter with headroom", () => {
    const orgId = createUuidV7();
    const meter = UsageMeter.startPeriod(orgId, "2026-06", "free");

    expect(meter.orgId).toBe(orgId);
    expect(meter.period).toBe("2026-06");
    expect(meter.planId).toBe("free");
    expect(meter.writes).toBe(0);
    expect(meter.reads).toBe(0);
    expect(meter.storageBytes).toBe(0);
    expect(meter.signalTokens).toBe(0);
    expect(meter.limitReached).toBeNull();
    expect(meter.canRecordSignalToken()).toBe(true);
    expect(meter.canRecordWrite()).toBe(true);
    expect(meter.canRecordRead()).toBe(true);
    expect(meter.canStore(1024)).toBe(true);
  });

  concurrentTest("rejects invalid periods", () => {
    const orgId = createUuidV7();

    for (const badPeriod of ["2026-13", "2026", "bad", "2026-00", "26-06"]) {
      expect(() => UsageMeter.startPeriod(orgId, badPeriod, "free")).toThrow(
        CoreValidationError,
      );
    }

    try {
      UsageMeter.startPeriod(orgId, "2026-13", "free");
      throw new Error("expected an invalid period to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CoreValidationError);
      expect((error as CoreValidationError).code).toBe("INVALID_USAGE_PERIOD");
    }
  });

  concurrentTest("rejects negative or non-integer counts on rehydrate", () => {
    const orgId = createUuidV7();
    const base = {
      orgId,
      period: "2026-06",
      planId: "free" as const,
      writes: 0,
      reads: 0,
      storageBytes: 0,
      signalTokens: 0,
    };

    expect(() => UsageMeter.rehydrate({ ...base, writes: -1 })).toThrow(
      CoreValidationError,
    );
    expect(() => UsageMeter.rehydrate({ ...base, reads: 1.5 })).toThrow(
      CoreValidationError,
    );
    expect(() => UsageMeter.rehydrate({ ...base, storageBytes: -10 })).toThrow(
      CoreValidationError,
    );
    expect(() => UsageMeter.rehydrate({ ...base, signalTokens: -1 })).toThrow(
      CoreValidationError,
    );

    try {
      UsageMeter.rehydrate({ ...base, writes: -1 });
      throw new Error("expected invalid count to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CoreValidationError);
      expect((error as CoreValidationError).code).toBe("INVALID_USAGE_COUNT");
    }
  });

  concurrentTest("recordWrite returns a new immutable instance", () => {
    const orgId = createUuidV7();
    const meter = UsageMeter.startPeriod(orgId, "2026-06", "free");
    const next = meter.recordWrite();

    expect(next).not.toBe(meter);
    expect(next.writes).toBe(1);
    expect(next.limitReached).toBeNull();
    // original unchanged
    expect(meter.writes).toBe(0);
  });

  concurrentTest(
    "recordWrite flags limitReached at the cap then throws past it",
    () => {
      const orgId = createUuidV7();
      const atBoundary = UsageMeter.rehydrate({
        orgId,
        period: "2026-06",
        planId: "free",
        writes: 999,
        reads: 0,
        storageBytes: 0,
        signalTokens: 0,
      });

      const reached = atBoundary.recordWrite();
      expect(reached.writes).toBe(1000);
      expect(reached.limitReached).toBe("write");
      expect(reached.canRecordWrite()).toBe(false);

      try {
        reached.recordWrite();
        throw new Error("expected recordWrite past cap to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(UsageLimitExceededError);
        expect((error as UsageLimitExceededError).kind).toBe("write");
      }
    },
  );

  concurrentTest(
    "recordRead flags limitReached at the cap then throws past it",
    () => {
      const orgId = createUuidV7();
      const atBoundary = UsageMeter.rehydrate({
        orgId,
        period: "2026-06",
        planId: "free",
        writes: 0,
        reads: 2999,
        storageBytes: 0,
        signalTokens: 0,
      });

      const reached = atBoundary.recordRead();
      expect(reached.reads).toBe(3000);
      expect(reached.limitReached).toBe("read");
      expect(reached.canRecordRead()).toBe(false);
      // writes untouched
      expect(reached.writes).toBe(0);

      try {
        reached.recordRead();
        throw new Error("expected recordRead past cap to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(UsageLimitExceededError);
        expect((error as UsageLimitExceededError).kind).toBe("read");
      }
    },
  );

  concurrentTest("recordSignalToken increments only signalTokens", () => {
    const orgId = createUuidV7();
    const meter = UsageMeter.rehydrate({
      orgId,
      period: "2026-06",
      planId: "free",
      writes: 7,
      reads: 11,
      storageBytes: 13,
      signalTokens: 0,
    });
    const next = meter.recordSignalToken();

    expect(next).not.toBe(meter);
    expect(next.signalTokens).toBe(1);
    expect(next.limitReached).toBeNull();
    expect(next.writes).toBe(7);
    expect(next.reads).toBe(11);
    expect(next.storageBytes).toBe(13);
    expect(meter.signalTokens).toBe(0);
  });

  concurrentTest(
    "recordSignalToken flags limitReached at the cap then throws past it",
    () => {
      const orgId = createUuidV7();
      const cap = PLAN_LIMITS_CONFIG.free.maxSignalTokensPerMonth;
      const atBoundary = UsageMeter.rehydrate({
        orgId,
        period: "2026-06",
        planId: "free",
        writes: 0,
        reads: 0,
        storageBytes: 0,
        signalTokens: cap - 1,
      });

      const reached = atBoundary.recordSignalToken();
      expect(reached.signalTokens).toBe(cap);
      expect(reached.limitReached).toBe("signal");
      expect(reached.canRecordSignalToken()).toBe(false);
      expect(reached.writes).toBe(0);
      expect(reached.reads).toBe(0);

      try {
        reached.recordSignalToken();
        throw new Error("expected recordSignalToken past cap to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(UsageLimitExceededError);
        expect((error as UsageLimitExceededError).kind).toBe("signal");
        expect((error as UsageLimitExceededError).code).toBe(
          "USAGE_LIMIT_EXCEEDED_SIGNAL",
        );
      }
    },
  );

  concurrentTest("recordBytes adds within the cap", () => {
    const orgId = createUuidV7();
    const meter = UsageMeter.startPeriod(orgId, "2026-06", "free");
    const next = meter.recordBytes(1024);

    expect(next).not.toBe(meter);
    expect(next.storageBytes).toBe(1024);
    expect(next.limitReached).toBeNull();
    expect(meter.storageBytes).toBe(0);
  });

  concurrentTest("recordBytes throws when an add exceeds the cap", () => {
    const orgId = createUuidV7();
    const nearCap = UsageMeter.rehydrate({
      orgId,
      period: "2026-06",
      planId: "free",
      writes: 0,
      reads: 0,
      storageBytes: FREE_STORAGE_CAP - 1,
      signalTokens: 0,
    });

    try {
      nearCap.recordBytes(2);
      throw new Error("expected recordBytes over cap to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UsageLimitExceededError);
      expect((error as UsageLimitExceededError).kind).toBe("storage");
    }
  });

  concurrentTest("recordBytes flags limitReached when reaching the cap", () => {
    const orgId = createUuidV7();
    const nearCap = UsageMeter.rehydrate({
      orgId,
      period: "2026-06",
      planId: "free",
      writes: 0,
      reads: 0,
      storageBytes: FREE_STORAGE_CAP - 1,
      signalTokens: 0,
    });

    const reached = nearCap.recordBytes(1);
    expect(reached.storageBytes).toBe(FREE_STORAGE_CAP);
    expect(reached.limitReached).toBe("storage");
  });

  concurrentTest("recordBytes decrement never throws and floors at 0", () => {
    const orgId = createUuidV7();
    const meter = UsageMeter.rehydrate({
      orgId,
      period: "2026-06",
      planId: "free",
      writes: 0,
      reads: 0,
      storageBytes: 5000,
      signalTokens: 0,
    });

    const floored = meter.recordBytes(-Number.MAX_SAFE_INTEGER);
    expect(floored.storageBytes).toBe(0);
    expect(floored.limitReached).toBeNull();
  });

  concurrentTest("recordBytes rejects a non-integer delta", () => {
    const orgId = createUuidV7();
    const meter = UsageMeter.startPeriod(orgId, "2026-06", "free");

    try {
      meter.recordBytes(1.5);
      throw new Error("expected non-integer delta to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CoreValidationError);
      expect((error as CoreValidationError).code).toBe(
        "INVALID_USAGE_BYTES_DELTA",
      );
    }
  });

  concurrentTest(
    "withStorageBytes sets an absolute value and leaves writes/reads untouched",
    () => {
      const orgId = createUuidV7();
      const meter = UsageMeter.rehydrate({
        orgId,
        period: "2026-06",
        planId: "free",
        writes: 42,
        reads: 99,
        storageBytes: 5000,
        signalTokens: 0,
      });

      const next = meter.withStorageBytes(123);
      expect(next).not.toBe(meter);
      expect(next.storageBytes).toBe(123);
      expect(next.writes).toBe(42);
      expect(next.reads).toBe(99);
      expect(next.limitReached).toBeNull();
    },
  );

  concurrentTest("withStorageBytes rejects negative values", () => {
    const orgId = createUuidV7();
    const meter = UsageMeter.startPeriod(orgId, "2026-06", "free");

    expect(() => meter.withStorageBytes(-1)).toThrow(CoreValidationError);
  });
});

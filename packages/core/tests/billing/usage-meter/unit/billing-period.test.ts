import { describe, expect } from "bun:test";
import {
  currentBillingPeriod,
  nextPeriodStart,
} from "@/billing/usage-meter/domain/billing-period";
import { concurrentTest } from "tests/utils";

describe("current billing period", () => {
  concurrentTest("formats a known UTC date as YYYY-MM", () => {
    expect(currentBillingPeriod(new Date("2026-06-28T23:30:00Z"))).toBe(
      "2026-06",
    );
  });

  concurrentTest("zero-pads single-digit months", () => {
    expect(currentBillingPeriod(new Date("2026-01-01T00:00:00Z"))).toBe(
      "2026-01",
    );
    expect(currentBillingPeriod(new Date("2026-09-15T12:00:00Z"))).toBe(
      "2026-09",
    );
  });

  concurrentTest("resolves the period in UTC across a local boundary", () => {
    // 2026-06-30T23:30:00-05:00 is 2026-07-01T04:30:00Z. The period is the UTC
    // month (July), independent of the offset embedded in the timestamp.
    expect(currentBillingPeriod(new Date("2026-06-30T23:30:00-05:00"))).toBe(
      "2026-07",
    );
    // 2026-07-01T00:30:00+05:00 is 2026-06-30T19:30:00Z -> June by UTC.
    expect(currentBillingPeriod(new Date("2026-07-01T00:30:00+05:00"))).toBe(
      "2026-06",
    );
  });
});

describe("next period start", () => {
  concurrentTest(
    "returns midnight UTC on the first of the following month",
    () => {
      expect(nextPeriodStart("2026-06").toISOString()).toBe(
        "2026-07-01T00:00:00.000Z",
      );
    },
  );

  concurrentTest("rolls December over to January of the next year", () => {
    expect(nextPeriodStart("2026-12").toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });

  concurrentTest("handles single-digit months", () => {
    expect(nextPeriodStart("2026-01").toISOString()).toBe(
      "2026-02-01T00:00:00.000Z",
    );
  });
});

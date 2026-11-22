import { describe, expect } from "bun:test";
import {
  STORAGE_RETENTION_DAYS,
  isArchiveExpired,
  taskLifecycleRule,
} from "@/billing/usage-meter/domain/storage-retention";
import { concurrentTest } from "tests/utils";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const daysAgo = (now: Date, days: number): Date =>
  new Date(now.getTime() - days * MS_PER_DAY);

describe("storage retention", () => {
  concurrentTest("retention window is 30 days", () => {
    expect(STORAGE_RETENTION_DAYS).toBe(30);
  });

  concurrentTest("an archive exactly at the boundary is not expired", () => {
    const now = new Date("2026-06-28T00:00:00Z");
    // age === retentionDays exactly; helper uses strict >, so not expired.
    expect(isArchiveExpired(daysAgo(now, STORAGE_RETENTION_DAYS), now)).toBe(
      false,
    );
  });

  concurrentTest("an archive just inside the window is not expired", () => {
    const now = new Date("2026-06-28T00:00:00Z");
    expect(isArchiveExpired(daysAgo(now, 29), now)).toBe(false);
  });

  concurrentTest("an archive just past the window is expired", () => {
    const now = new Date("2026-06-28T00:00:00Z");
    expect(isArchiveExpired(daysAgo(now, 31), now)).toBe(true);
  });

  concurrentTest(
    "the lifecycle expires log archives, artifacts and saved sessions",
    () => {
      expect(
        taskLifecycleRule().Rules.map((rule) => ({
          prefix: rule.Filter.Prefix,
          days: rule.Expiration.Days,
        })),
      ).toEqual([
        { prefix: "step-executions/", days: STORAGE_RETENTION_DAYS },
        { prefix: "artifacts/", days: STORAGE_RETENTION_DAYS },
        { prefix: "tasks/", days: STORAGE_RETENTION_DAYS },
      ]);
    },
  );

  concurrentTest("respects a custom retentionDays argument", () => {
    const now = new Date("2026-06-28T00:00:00Z");
    expect(isArchiveExpired(daysAgo(now, 8), now, 7)).toBe(true);
    expect(isArchiveExpired(daysAgo(now, 7), now, 7)).toBe(false);
  });
});

import { describe, expect } from "bun:test";
import { concurrentTest, fixedTimeProvider } from "tests/utils";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { UsageMeter } from "@/billing/usage-meter/domain/usage-meter-entity";
import { RecordUsageOnArtifactDeleted } from "@/billing/usage-meter/application/record-usage-on-artifact-deleted";
import { ArtifactDeletedDomainEvent } from "@/tasks/task-artifact/domain/artifact-deleted.domain-event";
import type { UsageMeterRepo } from "@/billing/usage-meter/application/usage-meter-repo";
import type { DomainEventHandlerContext } from "@/lib/domain-events/domain-event";

const NOW = new Date("2026-06-15T12:00:00.000Z");
const PERIOD = "2026-06";

// Passing an executor without a `transaction` method makes handlers reuse it
// directly; the repo is a stub, so it is never actually touched.
const fakeContext: DomainEventHandlerContext = { tx: {} as never };

/**
 * A `UsageMeterRepo` stub whose `loadOrStart` returns a pre-seeded meter (via
 * `UsageMeter.rehydrate`) when `initial` is provided, or a fresh
 * `UsageMeter.startPeriod(...)` when it is not — mirroring the real repo's
 * "load existing, or hand back a zeroed meter" contract for a period with no
 * persisted row yet. `RecordUsageOnArtifactDeleted` only ever calls
 * `loadOrStart` (never `loadForPeriod`), so that is the only method stubbed.
 */
const fakeUsageMeterRepo = (
  orgId: UuidV7,
  initial?: UsageMeter,
): { repo: UsageMeterRepo; current: () => UsageMeter } => {
  let meter: UsageMeter | null = initial ?? null;
  return {
    current: () => {
      if (!meter) {
        throw new Error("Expected the meter to have been saved");
      }
      return meter;
    },
    repo: {
      loadForPeriod: () => Promise.resolve(null),
      loadOrStart: () =>
        Promise.resolve(meter ?? UsageMeter.startPeriod(orgId, PERIOD, "free")),
      save: (next: UsageMeter) => {
        meter = next;
        return Promise.resolve(next);
      },
      reconcileStorageForPeriod: () => Promise.resolve(0),
    },
  };
};

describe("RecordUsageOnArtifactDeleted", () => {
  concurrentTest(
    "decrements storageBytes by the event's sizeBytes",
    async () => {
      const orgId = createUuidV7();
      const existingMeter = UsageMeter.rehydrate({
        orgId,
        period: PERIOD,
        planId: "free",
        writes: 3,
        reads: 0,
        storageBytes: 10_000,
        signalTokens: 0,
      });
      const { repo, current } = fakeUsageMeterRepo(orgId, existingMeter);
      const handler = new RecordUsageOnArtifactDeleted({
        usageMeterRepo: repo,
        timeProvider: fixedTimeProvider(NOW),
      });

      await handler.handle(
        new ArtifactDeletedDomainEvent({
          orgId,
          projectId: createUuidV7(),
          taskRunId: createUuidV7(),
          artifactId: createUuidV7(),
          sizeBytes: 4096,
        }),
        fakeContext,
      );

      expect(current().storageBytes).toBe(10_000 - 4096);
      // Untouched by the reversal: only storageBytes is adjusted.
      expect(current().writes).toBe(3);
    },
  );

  concurrentTest(
    "floors at 0 rather than going negative when the delta exceeds current storageBytes",
    async () => {
      const orgId = createUuidV7();
      const existingMeter = UsageMeter.rehydrate({
        orgId,
        period: PERIOD,
        planId: "free",
        writes: 0,
        reads: 0,
        storageBytes: 1024,
        signalTokens: 0,
      });
      const { repo, current } = fakeUsageMeterRepo(orgId, existingMeter);
      const handler = new RecordUsageOnArtifactDeleted({
        usageMeterRepo: repo,
        timeProvider: fixedTimeProvider(NOW),
      });

      await handler.handle(
        new ArtifactDeletedDomainEvent({
          orgId,
          projectId: createUuidV7(),
          taskRunId: createUuidV7(),
          artifactId: createUuidV7(),
          sizeBytes: 4096,
        }),
        fakeContext,
      );

      expect(current().storageBytes).toBe(0);
    },
  );

  concurrentTest(
    "starts a fresh meter (via loadOrStart) when none exists yet for the period, floored at 0",
    async () => {
      const orgId = createUuidV7();
      // No `initial` meter — `loadOrStart` falls back to
      // `UsageMeter.startPeriod`, exactly as the real repo does for a period
      // with no persisted row yet.
      const { repo, current } = fakeUsageMeterRepo(orgId);
      const handler = new RecordUsageOnArtifactDeleted({
        usageMeterRepo: repo,
        timeProvider: fixedTimeProvider(NOW),
      });

      await handler.handle(
        new ArtifactDeletedDomainEvent({
          orgId,
          projectId: createUuidV7(),
          taskRunId: createUuidV7(),
          artifactId: createUuidV7(),
          sizeBytes: 2048,
        }),
        fakeContext,
      );

      expect(current().storageBytes).toBe(0);
      expect(current().period).toBe(PERIOD);
    },
  );
});

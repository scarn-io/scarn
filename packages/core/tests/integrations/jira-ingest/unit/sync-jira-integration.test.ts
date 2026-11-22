import { expect, test } from "bun:test";
import {
  JIRA_SCHEDULED_OVERLAP_MS,
  jiraSyncSinceIso,
} from "@scarn/core/integrations/jira-ingest/application/sync-jira-integration";

const now = new Date("2026-06-15T12:00:00.000Z");

test("Jira first sync respects the requested horizon and defaults to 30 days", () => {
  expect(
    jiraSyncSinceIso({ lastSyncedAt: null, firstSyncHorizonDays: 7 }, now),
  ).toBe("2026-06-08T12:00:00.000Z");
  expect(
    jiraSyncSinceIso({ lastSyncedAt: null, firstSyncHorizonDays: null }, now),
  ).toBe("2026-05-16T12:00:00.000Z");
});

test("Jira incremental sync uses its watermark, not its first-sync horizon", () => {
  expect(
    jiraSyncSinceIso(
      {
        lastSyncedAt: new Date("2026-06-14T00:00:00.000Z"),
        firstSyncHorizonDays: 7,
      },
      now,
    ),
  ).toBe("2026-06-14T00:00:00.000Z");
});

test("Jira incremental sync starts overlapMs before its watermark", () => {
  const integration = {
    lastSyncedAt: new Date("2026-06-14T00:00:00.000Z"),
    firstSyncHorizonDays: null,
  };
  expect(jiraSyncSinceIso(integration, now, 0)).toBe(
    "2026-06-14T00:00:00.000Z",
  );
  expect(jiraSyncSinceIso(integration, now, JIRA_SCHEDULED_OVERLAP_MS)).toBe(
    "2026-06-13T23:58:00.000Z",
  );
});

test("Jira first sync ignores overlapMs", () => {
  expect(
    jiraSyncSinceIso(
      { lastSyncedAt: null, firstSyncHorizonDays: 7 },
      now,
      JIRA_SCHEDULED_OVERLAP_MS,
    ),
  ).toBe("2026-06-08T12:00:00.000Z");
});

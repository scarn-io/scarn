import { describe, expect, test } from "bun:test";
import {
  buildJiraSearchJql,
  formatJiraDateTimeInZone,
} from "@/integrations/jira-ingest/infra/jira-issues-client";

/**
 * Regression coverage for the CV-3344 missing-sync bug: Jira JQL date
 * literals (`updated >= "..."`) have no timezone-offset syntax and are
 * always parsed in the requesting account's own configured timezone, never
 * UTC. `formatJiraDateTimeInZone` is what turns a UTC watermark instant into
 * the correct wall-clock literal for that account's timezone, so that once
 * Jira reapplies its own timezone, the comparison lands back on the
 * intended UTC instant instead of silently drifting.
 */
describe("formatJiraDateTimeInZone", () => {
  test("reproduces the CV-3344 scenario: converts a UTC instant to America/Chicago wall-clock digits", () => {
    // This is the exact instant used to demonstrate the bug live against
    // Jira: naively slicing UTC digits ("2026-09-04 18:00") into the JQL
    // literal got interpreted by Jira as 18:00 America/Chicago (23:00 UTC),
    // a cutoff *later* than CV-3344's true update time of 21:08 UTC — so it
    // (and every other issue updated in that trailing window) was silently
    // excluded from the incremental sync, forever, once the watermark moved
    // past it.
    const result = formatJiraDateTimeInZone(
      "2026-09-04T18:00:00.000Z",
      "America/Chicago",
    );
    // Chicago is UTC-5 in September (CDT) -> 18:00Z - 5h = 13:00 local.
    // When Jira reinterprets "2026-09-04 13:00" in the account's own
    // America/Chicago timezone, it reconstructs 18:00Z — the correct,
    // intended cutoff — so CV-3344's 21:08Z update correctly clears it.
    expect(result).toBe("2026-09-04 13:00");
  });

  test("is a no-op (identity) when the account timezone is UTC", () => {
    const result = formatJiraDateTimeInZone(
      "2026-09-05T19:41:27.231Z",
      "UTC",
    );
    expect(result).toBe("2026-09-05 19:41");
  });

  test("truncates to minute precision (Jira JQL date literals don't support seconds)", () => {
    const result = formatJiraDateTimeInZone(
      "2026-01-15T23:59:59.999Z",
      "UTC",
    );
    expect(result).toBe("2026-01-15 23:59");
  });

  test("adapts to the account's DST offset automatically (winter, CST = UTC-6)", () => {
    // Same literal digits construction, but in January the same IANA zone
    // is UTC-6 (CST, not CDT) — proving this is resolved from the zone name
    // per-instant rather than a hardcoded offset (which was effectively
    // what the original bug did: no offset awareness at all).
    const result = formatJiraDateTimeInZone(
      "2026-01-15T18:00:00.000Z",
      "America/Chicago",
    );
    expect(result).toBe("2026-01-15 12:00");
  });

  test("handles a positive-offset zone", () => {
    const result = formatJiraDateTimeInZone(
      "2026-06-01T02:30:00.000Z",
      "Asia/Kolkata", // UTC+5:30
    );
    expect(result).toBe("2026-06-01 08:00");
  });

  test("rolls the date across midnight when the zone shifts it to the previous/next day", () => {
    const result = formatJiraDateTimeInZone(
      "2026-09-04T02:00:00.000Z",
      "America/Chicago", // UTC-5 -> previous calendar day locally
    );
    expect(result).toBe("2026-09-03 21:00");
  });
});

describe("buildJiraSearchJql", () => {
  test("omits the updated filter entirely when there's no watermark (first sync)", () => {
    const jql = buildJiraSearchJql("CV", null, "America/Chicago");
    expect(jql).toBe('project = "CV" ORDER BY updated ASC');
  });

  test("reproduces the fixed CV-3344 query: builds the since-literal in the account's timezone, not raw UTC", () => {
    const jql = buildJiraSearchJql(
      "CV",
      "2026-09-04T18:00:00.000Z",
      "America/Chicago",
    );
    expect(jql).toBe(
      'project = "CV" AND updated >= "2026-09-04 13:00" ORDER BY updated ASC',
    );
    // Sanity: this must NOT be the old, buggy literal (the raw UTC digits),
    // which is what caused Jira to silently reinterpret the cutoff 5 hours
    // later than intended and drop CV-3344.
    expect(jql).not.toContain('"2026-09-04 18:00"');
  });

  test("falls back to treating the literal as UTC when no timeZone is supplied", () => {
    const jql = buildJiraSearchJql(
      "CV",
      "2026-09-04T18:00:00.000Z",
      undefined,
    );
    expect(jql).toBe(
      'project = "CV" AND updated >= "2026-09-04 18:00" ORDER BY updated ASC',
    );
  });
});

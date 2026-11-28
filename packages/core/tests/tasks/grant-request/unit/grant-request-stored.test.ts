import { describe, expect } from "bun:test";
import {
  CURRENT_GRANT_REQUEST_SCHEMA_VERSION,
  readStoredGrantRequest,
} from "@/tasks/grant-request/contracts/grant-request-stored";
import { concurrentTest } from "tests/utils";
import v1Decided from "../fixtures/v1-decided.json";
import v1Denied from "../fixtures/v1-denied.json";
import v1Pending from "../fixtures/v1-pending.json";

const fixtures = {
  pending: v1Pending,
  decided: v1Decided,
  denied: v1Denied,
};

describe("task_grant_requests stored reader", () => {
  for (const [name, fixture] of Object.entries(fixtures)) {
    concurrentTest(`reads the v1 ${name} fixture`, () => {
      expect(fixture.schemaVersion).toBe(CURRENT_GRANT_REQUEST_SCHEMA_VERSION);
      expect(
        readStoredGrantRequest(fixture.schemaVersion, fixture) as unknown,
      ).toEqual({
        success: true,
        value: {
          requested: fixture.requestedJson,
          approved: fixture.approvedJson,
        },
      });
    });
  }

  concurrentTest("reads grants today's write rules would refuse", () => {
    const requestedJson = [
      { resource: "workItem", action: "retired_action", scope: "self" },
      { resource: "workItem", action: "label", scope: "self", labels: [] },
    ];
    const read = readStoredGrantRequest(1, {
      requestedJson,
      approvedJson: requestedJson,
    });
    expect(read.success && (read.value.requested as unknown)).toEqual(
      requestedJson,
    );
  });

  concurrentTest("a broken grant is unreadable", () => {
    const read = readStoredGrantRequest(1, {
      requestedJson: [{ resource: "workItem" }],
      approvedJson: null,
    });
    expect(read.success).toBe(false);
  });

  concurrentTest("an unknown schema version is unreadable", () => {
    expect(readStoredGrantRequest(99, v1Pending)).toEqual({
      success: false,
      reason: "unknown schema_version 99 (current is 1)",
    });
  });
});

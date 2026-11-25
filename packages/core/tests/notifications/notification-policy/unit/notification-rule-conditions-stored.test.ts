import { describe, expect } from "bun:test";
import { readStoredNotificationRuleConditions } from "@/notifications/notification-policy/contracts/notification-rule-conditions-stored";
import { concurrentTest } from "tests/utils";
import conditionsFixtures from "../fixtures/conditions.json";

describe("notification_rules.conditions_json stored reader", () => {
  for (const fixture of conditionsFixtures) {
    concurrentTest(`reads the ${fixture.name} fixture`, () => {
      expect(
        readStoredNotificationRuleConditions(fixture.conditionsJson) as unknown,
      ).toEqual({ success: true, value: fixture.conditionsJson });
    });
  }

  for (const [name, conditionsJson] of [
    ["an array", []],
    ["a string", "conditions"],
    ["a number", 1],
  ] as const) {
    concurrentTest(`reports ${name} as unreadable`, () => {
      expect(readStoredNotificationRuleConditions(conditionsJson).success).toBe(
        false,
      );
    });
  }
});

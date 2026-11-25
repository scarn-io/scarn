import { describe, expect } from "bun:test";
import { readStoredWorkItemFields } from "@/work-items/work-item/contracts/work-item-fields-stored";
import { concurrentTest } from "tests/utils";
import fieldsFixtures from "../fixtures/fields.json";

describe("work_items.fields stored reader", () => {
  for (const fixture of fieldsFixtures) {
    concurrentTest(`reads the ${fixture.name} fixture`, () => {
      expect(readStoredWorkItemFields(fixture.fields) as unknown).toEqual({
        success: true,
        value: fixture.fields,
      });
    });
  }

  for (const [name, fields] of [
    ["null", null],
    ["an array", ["a"]],
    ["a string", "fields"],
    ["a number", 1],
  ] as const) {
    concurrentTest(`reports ${name} as unreadable`, () => {
      expect(readStoredWorkItemFields(fields).success).toBe(false);
    });
  }
});

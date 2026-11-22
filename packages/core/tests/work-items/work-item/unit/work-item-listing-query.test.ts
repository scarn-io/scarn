import { describe, expect } from "bun:test";
import { concurrentTest } from "tests/utils";
import {
  MAX_FIELD_OPTION_KEYS,
  MAX_FIELD_OPTION_VALUES,
} from "@/work-items/work-item/contracts/work-item-contracts";
import {
  escapeLikeWildcards,
  groupFieldOptionRows,
  toContainsPattern,
  type WorkItemFieldOptionRow,
} from "@/work-items/work-item/infra/work-item-listing-query";

/**
 * The pure halves of the work item listing query. The `LIKE` escaping and the
 * option grouping are also pinned end-to-end by the integration suites; these
 * cases cover the boundaries (the 200-value and 100-key caps) that would need
 * hundreds of seeded rows to reach through the API.
 */
describe("escapeLikeWildcards", () => {
  concurrentTest("escapes the percent wildcard", () => {
    expect(escapeLikeWildcards("50% off")).toBe("50\\% off");
  });

  concurrentTest("escapes the underscore wildcard", () => {
    expect(escapeLikeWildcards("snake_case")).toBe("snake\\_case");
  });

  concurrentTest("escapes the escape character itself", () => {
    expect(escapeLikeWildcards("path\\to")).toBe("path\\\\to");
  });

  concurrentTest("escapes a backslash before the wildcard it precedes", () => {
    // `\%` must become `\\` + `\%`, not `\` + `%`, or the escaped backslash
    // would consume the escape of the percent.
    expect(escapeLikeWildcards("\\%")).toBe("\\\\\\%");
  });

  concurrentTest("leaves ordinary text untouched", () => {
    expect(escapeLikeWildcards("plain text 42")).toBe("plain text 42");
  });
});

describe("toContainsPattern", () => {
  concurrentTest("wraps the escaped needle in wildcards", () => {
    expect(toContainsPattern("a_b")).toBe("%a\\_b%");
  });
});

describe("groupFieldOptionRows", () => {
  const rowsFor = (key: string, values: string[]): WorkItemFieldOptionRow[] =>
    values.map((value) => ({ key, value }));

  concurrentTest("groups, dedupes, and sorts keys and values", () => {
    expect(
      groupFieldOptionRows([
        { key: "tier", value: "silver" },
        { key: "env", value: "prod" },
        { key: "env", value: "dev" },
        { key: "env", value: "prod" },
        { key: "tier", value: "gold" },
      ]),
    ).toEqual([
      { key: "env", values: ["dev", "prod"], truncated: false },
      { key: "tier", values: ["gold", "silver"], truncated: false },
    ]);
  });

  concurrentTest("skips rows with a null key or value", () => {
    expect(
      groupFieldOptionRows([
        { key: null, value: "orphan" },
        { key: "env", value: null },
        { key: "env", value: "prod" },
      ]),
    ).toEqual([{ key: "env", values: ["prod"], truncated: false }]);
  });

  concurrentTest("returns an empty list for no rows", () => {
    expect(groupFieldOptionRows([])).toEqual([]);
  });

  concurrentTest("does not flag a key sitting exactly on the cap", () => {
    const values = Array.from(
      { length: MAX_FIELD_OPTION_VALUES },
      (_v, index) => `value-${String(index).padStart(4, "0")}`,
    );

    const [option] = groupFieldOptionRows(rowsFor("big", values));

    expect(option?.values).toHaveLength(MAX_FIELD_OPTION_VALUES);
    expect(option?.truncated).toBeFalse();
  });

  concurrentTest("caps values per key and flags the overflow", () => {
    const values = Array.from(
      { length: MAX_FIELD_OPTION_VALUES + 5 },
      (_v, index) => `value-${String(index).padStart(4, "0")}`,
    );

    const [option] = groupFieldOptionRows(
      rowsFor("big", [...values].reverse()),
    );

    expect(option?.truncated).toBeTrue();
    // Kept values are the sorted first N, not whatever arrived first.
    expect(option?.values).toEqual(values.slice(0, MAX_FIELD_OPTION_VALUES));
  });

  concurrentTest("caps the number of keys, keeping the sorted first", () => {
    const rows = Array.from(
      { length: MAX_FIELD_OPTION_KEYS + 5 },
      (_v, index) => ({
        key: `key-${String(index).padStart(4, "0")}`,
        value: "present",
      }),
    );

    const options = groupFieldOptionRows([...rows].reverse());

    expect(options).toHaveLength(MAX_FIELD_OPTION_KEYS);
    expect(options.map((option) => option.key)).toEqual(
      rows.slice(0, MAX_FIELD_OPTION_KEYS).map((row) => row.key),
    );
  });
});

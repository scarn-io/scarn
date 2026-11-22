import { describe, expect, test } from "bun:test";
import {
  mergeActiveFieldFilterValues,
  type WorkItemFieldFilterOption,
} from "./project-work-items";

/**
 * The field-options endpoint caps how many values it returns per key and how
 * many keys it returns, so a value the user is actively filtering on can be
 * missing from the dropdown. `WorkItemFieldFilters` falls back to `""` for an
 * unknown value, which would blank the control while the filter is still
 * applied — merging the active values back in is what prevents that.
 */
describe("mergeActiveFieldFilterValues", () => {
  const options: WorkItemFieldFilterOption[] = [
    { key: "env", values: ["dev", "prod"], truncated: false },
    { key: "tier", values: ["gold", "silver"], truncated: true },
  ];

  test("returns the options unchanged when every value is present", () => {
    const merged = mergeActiveFieldFilterValues(options, [
      { key: "env", value: "prod" },
      { key: "tier", value: "gold" },
    ]);

    // Same identity, so callers can memoize on it.
    expect(merged).toBe(options);
  });

  test("inserts a missing value in sorted position", () => {
    const merged = mergeActiveFieldFilterValues(options, [
      { key: "env", value: "staging" },
    ]);

    expect(merged).toEqual([
      { key: "env", values: ["dev", "prod", "staging"], truncated: false },
      { key: "tier", values: ["gold", "silver"], truncated: true },
    ]);
  });

  test("inserts before a value that sorts after it", () => {
    const merged = mergeActiveFieldFilterValues(options, [
      { key: "env", value: "canary" },
    ]);

    expect(merged[0]?.values).toEqual(["canary", "dev", "prod"]);
  });

  test("inserts in the middle of an existing value list", () => {
    const merged = mergeActiveFieldFilterValues(options, [
      { key: "tier", value: "platinum" },
    ]);

    expect(merged[1]?.values).toEqual(["gold", "platinum", "silver"]);
  });

  test("adds a key that is absent entirely, in sorted position", () => {
    const merged = mergeActiveFieldFilterValues(options, [
      { key: "region", value: "eu" },
    ]);

    expect(merged).toEqual([
      { key: "env", values: ["dev", "prod"], truncated: false },
      // Synthesized from a single active filter, so it is knowingly incomplete.
      { key: "region", values: ["eu"], truncated: true },
      { key: "tier", values: ["gold", "silver"], truncated: true },
    ]);
  });

  test("appends a key that sorts after every known key", () => {
    const merged = mergeActiveFieldFilterValues(options, [
      { key: "zone", value: "a" },
    ]);

    expect(merged.map((option) => option.key)).toEqual(["env", "tier", "zone"]);
  });

  test("does not duplicate a value already present", () => {
    const merged = mergeActiveFieldFilterValues(
      [{ key: "env", values: ["prod"], truncated: false }],
      [
        { key: "env", value: "prod" },
        { key: "env", value: "prod" },
      ],
    );

    expect(merged).toEqual([
      { key: "env", values: ["prod"], truncated: false },
    ]);
  });

  test("merges several filters across several keys", () => {
    const merged = mergeActiveFieldFilterValues(options, [
      { key: "env", value: "staging" },
      { key: "tier", value: "bronze" },
      { key: "region", value: "eu" },
    ]);

    expect(merged).toEqual([
      { key: "env", values: ["dev", "prod", "staging"], truncated: false },
      { key: "region", values: ["eu"], truncated: true },
      { key: "tier", values: ["bronze", "gold", "silver"], truncated: true },
    ]);
  });

  test("skips filters with a blank key or value", () => {
    const merged = mergeActiveFieldFilterValues(options, [
      { key: "", value: "prod" },
      { key: "env", value: "" },
    ]);

    expect(merged).toBe(options);
  });

  test("does not mutate its arguments", () => {
    const original: WorkItemFieldFilterOption[] = [
      { key: "env", values: ["prod"], truncated: false },
    ];

    mergeActiveFieldFilterValues(original, [
      { key: "env", value: "dev" },
      { key: "region", value: "eu" },
    ]);

    expect(original).toEqual([
      { key: "env", values: ["prod"], truncated: false },
    ]);
  });

  test("returns an empty list when there are no options or filters", () => {
    expect(mergeActiveFieldFilterValues([], [])).toEqual([]);
  });

  test("builds the whole list from active filters when options are empty", () => {
    const merged = mergeActiveFieldFilterValues(
      [],
      [
        { key: "tier", value: "gold" },
        { key: "env", value: "prod" },
      ],
    );

    expect(merged).toEqual([
      { key: "env", values: ["prod"], truncated: true },
      { key: "tier", values: ["gold"], truncated: true },
    ]);
  });
});

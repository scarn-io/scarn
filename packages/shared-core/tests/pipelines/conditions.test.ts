import { describe, expect, test } from "bun:test";
import type { Condition } from "@scarn/sdk/contracts/pipeline-document";
import {
  applyOperator,
  ConditionError,
  evaluateCondition,
  type ReferenceContext,
} from "../../src/pipelines";

const context: ReferenceContext = {
  result: {
    quality: 0.4,
    verdict: "reproduced",
    title: "Fix login bug",
    tags: ["auth", "urgent"],
    empty: [],
    blank: "",
    nothing: null,
    finishedAt: "2026-10-24T12:00:00Z",
    correctness: 0.9,
    clarity: 0.6,
    obj: {},
  },
  input: {
    reviews: [
      { approved: true, confidence: 0.9 },
      { approved: false, confidence: 0.5 },
      { approved: true, confidence: 0.7 },
    ],
  },
  nodes: { review: { result: { coverage: 0.3, limit: 0.5 } } },
};

const check = (condition: Condition, ctx: ReferenceContext = context) =>
  evaluateCondition(condition, ctx).value;

describe("operators", () => {
  test.concurrent.each([
    ["equal", 1, 1, true],
    ["equal", { a: [1] }, { a: [1] }, true],
    ["equal", undefined, null, true],
    ["notEqual", "a", "b", true],
    ["notEqual", 1, 1, false],
    ["lessThan", 1, 2, true],
    ["lessThan", 2, 2, false],
    ["lessThanInclusive", 2, 2, true],
    ["greaterThan", 3, 2, true],
    ["greaterThanInclusive", 2, 2, true],
    ["greaterThan", "b", "a", true],
    ["greaterThan", "2", 1, false],
    ["lessThan", undefined, 1, false],
    ["exists", 0, undefined, true],
    ["exists", null, undefined, false],
    ["exists", undefined, undefined, false],
    ["isEmpty", "", undefined, true],
    ["isEmpty", [], undefined, true],
    ["isEmpty", {}, undefined, true],
    ["isEmpty", null, undefined, true],
    ["isEmpty", "x", undefined, false],
    ["isEmpty", 0, undefined, false],
    ["contains", "hello", "ell", true],
    ["contains", ["a", "b"], "b", true],
    ["contains", [{ a: 1 }], { a: 1 }, true],
    ["contains", ["a"], "c", false],
    ["startsWith", "hello", "he", true],
    ["endsWith", "hello", "lo", true],
    ["endsWith", 5, "5", false],
    ["matches", "abc123", "^[a-z]+\\d+$", true],
    ["matches", "abc", "(", false],
    ["before", "2026-01-01", "2026-06-01", true],
    ["after", "2026-01-01", "2026-06-01", false],
    ["after", "not a date", "2026-06-01", false],
  ] as const)("%s(%p, %p) is %p", (op, left, right, expected) => {
    expect(applyOperator(op, left as never, right as never)).toBe(expected);
  });
});

describe("evaluateCondition", () => {
  test.concurrent("compares paths with values and refs", () => {
    expect(check({ path: "result.quality", op: "lessThan", value: 0.5 })).toBe(
      true,
    );
    expect(
      check({
        path: "result.quality",
        op: "greaterThan",
        ref: "nodes.review.result.limit",
      }),
    ).toBe(false);
    expect(check({ path: "result.tags.length", op: "equal", value: 2 })).toBe(
      true,
    );
    expect(
      check({ path: "result.title.length", op: "greaterThan", value: 5 }),
    ).toBe(true);
    expect(check({ path: "result.missing", op: "exists" })).toBe(false);
    expect(check({ path: "result.nothing", op: "isEmpty" })).toBe(true);
    expect(
      check({
        path: "result.finishedAt",
        op: "after",
        value: "2026-01-01T00:00:00Z",
      }),
    ).toBe(true);
  });

  test.concurrent("combines with all, any and not, short-circuiting", () => {
    const outcome = evaluateCondition(
      {
        all: [
          { path: "result.quality", op: "greaterThan", value: 1 },
          { path: "result.missing", op: "exists" },
        ],
      },
      context,
    );
    expect(outcome.value).toBe(false);
    expect(outcome.record).toMatchObject({
      kind: "all",
      conditions: [{ kind: "compare", result: false }],
    });
    expect(
      check({
        any: [
          { path: "result.quality", op: "greaterThan", value: 1 },
          { path: "result.verdict", op: "equal", value: "reproduced" },
        ],
      }),
    ).toBe(true);
    expect(
      check({
        not: { path: "result.verdict", op: "equal", value: "reproduced" },
      }),
    ).toBe(false);
  });

  test.concurrent(
    "evaluates list conditions with element-relative paths",
    () => {
      const where: Condition = { path: "approved", op: "equal", value: false };
      expect(check({ path: "input.reviews", op: "some", where })).toBe(true);
      expect(check({ path: "input.reviews", op: "every", where })).toBe(false);
      expect(check({ path: "input.reviews", op: "none", where })).toBe(false);
      expect(
        check({
          path: "input.reviews",
          op: "every",
          where: { path: "confidence", op: "greaterThan", value: 0.4 },
        }),
      ).toBe(true);
      expect(check({ path: "result.empty", op: "every", where })).toBe(true);
      expect(check({ path: "result.empty", op: "some", where })).toBe(false);
      expect(
        check({
          path: "result.tags",
          op: "some",
          where: { path: "length", op: "greaterThan", value: 5 },
        }),
      ).toBe(true);
    },
  );

  test.concurrent("refs inside where read the outer context", () => {
    expect(
      check({
        path: "input.reviews",
        op: "some",
        where: {
          path: "confidence",
          op: "lessThan",
          ref: "nodes.review.result.limit",
        },
      }),
    ).toBe(false);
  });

  test.concurrent("records the list check for the decision record", () => {
    const outcome = evaluateCondition(
      {
        path: "input.reviews",
        op: "some",
        where: { path: "approved", op: "equal", value: false },
      },
      context,
    );
    expect(outcome.record).toEqual({
      kind: "list",
      result: true,
      path: "input.reviews",
      op: "some",
      length: 3,
      matchedIndexes: [1],
    });
  });

  test.concurrent("records compared values", () => {
    const outcome = evaluateCondition(
      {
        path: "result.quality",
        op: "greaterThan",
        ref: "nodes.review.result.limit",
      },
      context,
    );
    expect(outcome.record).toEqual({
      kind: "compare",
      result: false,
      left: { path: "result.quality", value: 0.4 },
      op: "greaterThan",
      right: { ref: "nodes.review.result.limit", value: 0.5 },
    });
  });

  describe("computed values", () => {
    test.concurrent("over a list of references", () => {
      expect(
        check({
          avg: ["result.correctness", "result.clarity"],
          op: "greaterThan",
          value: 0.7499,
        }),
      ).toBe(true);
      expect(
        check({
          avg: ["result.correctness", "result.clarity"],
          weights: [2, 1],
          op: "lessThan",
          value: 0.8001,
        }),
      ).toBe(true);
      expect(
        check({
          sum: ["result.correctness", "nodes.review.result.coverage"],
          op: "greaterThan",
          value: 1.1999,
        }),
      ).toBe(true);
      expect(
        check({
          min: ["result.correctness", "result.clarity"],
          op: "equal",
          value: 0.6,
        }),
      ).toBe(true);
      expect(
        check({
          max: ["result.correctness", "result.clarity"],
          op: "equal",
          value: 0.9,
        }),
      ).toBe(true);
      expect(
        check({
          count: ["result.correctness", "result.nothing", "result.missing"],
          op: "equal",
          value: 1,
        }),
      ).toBe(true);
    });

    test.concurrent("skips missing values and their weights", () => {
      expect(
        check({
          avg: ["result.correctness", "result.missing"],
          weights: [1, 100],
          op: "equal",
          value: 0.9,
        }),
      ).toBe(true);
    });

    test.concurrent("over { path, field }", () => {
      expect(
        check({
          avg: { path: "input.reviews", field: "confidence" },
          op: "lessThan",
          value: 0.7001,
        }),
      ).toBe(true);
      expect(
        check({
          sum: { path: "input.reviews", field: "confidence" },
          op: "greaterThan",
          value: 2,
        }),
      ).toBe(true);
      expect(
        check({
          min: { path: "input.reviews", field: "confidence" },
          op: "equal",
          value: 0.5,
        }),
      ).toBe(true);
      expect(
        check({
          max: { path: "input.reviews", field: "confidence" },
          op: "equal",
          value: 0.9,
        }),
      ).toBe(true);
      expect(
        check({ count: { path: "input.reviews" }, op: "equal", value: 3 }),
      ).toBe(true);
      expect(
        check({
          count: {
            path: "input.reviews",
            where: { path: "approved", op: "equal", value: true },
          },
          op: "equal",
          value: 2,
        }),
      ).toBe(true);
    });

    test.concurrent("records the computed value", () => {
      const outcome = evaluateCondition(
        { count: { path: "input.reviews" }, op: "greaterThan", value: 2 },
        context,
      );
      expect(outcome.record).toMatchObject({
        left: { computed: "count", value: 3 },
      });
    });

    test.concurrent("empty sum and count give 0", () => {
      expect(
        check({
          sum: { path: "result.empty", field: "x" },
          op: "equal",
          value: 0,
        }),
      ).toBe(true);
      expect(
        check({ count: { path: "result.empty" }, op: "equal", value: 0 }),
      ).toBe(true);
      expect(check({ sum: ["result.missing"], op: "equal", value: 0 })).toBe(
        true,
      );
    });

    test.concurrent.each(["avg", "min", "max"] as const)(
      "empty %s raises Scarn.ConditionError",
      (fn) => {
        const condition = {
          [fn]: { path: "result.empty", field: "x" },
          op: "equal",
          value: 0,
        } as Condition;
        expect(() => evaluateCondition(condition, context)).toThrow(
          ConditionError,
        );
        try {
          evaluateCondition(
            { [fn]: ["result.missing"], op: "equal", value: 0 },
            context,
          );
          throw new Error("expected a ConditionError");
        } catch (error) {
          expect(error).toBeInstanceOf(ConditionError);
          expect((error as ConditionError).name).toBe("Scarn.ConditionError");
        }
      },
    );
  });
});

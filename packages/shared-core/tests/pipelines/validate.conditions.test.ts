import { describe, expect, test } from "bun:test";
import { bugPipeline, bugSteps, clone } from "./fixtures";
import { itemsPipeline, itemSteps } from "./fixtures-items";
import { errorsOf, expectError, nextOf } from "./helpers";

function bugWith(when: object) {
  const document = clone(bugPipeline());
  nextOf(document, "fix", 0)["when"] = when;
  return errorsOf(document, bugSteps);
}

function itemsWith(when: object) {
  const document = clone(itemsPipeline());
  nextOf(document, "approve-reviews", 0)["when"] = when;
  return errorsOf(document, itemSteps);
}

describe("condition operators fit the field type", () => {
  test.concurrent("accepts operators that fit", () => {
    const valid = [
      { path: "result.attempts", op: "greaterThan", value: 2 },
      {
        path: "result.attempts",
        op: "lessThanInclusive",
        ref: "nodes.evaluate.result.maxAttempts",
      },
      { path: "result.changedFiles", op: "contains", value: "a.ts" },
      { path: "result.changedFiles.length", op: "greaterThan", value: 0 },
      { path: "result.changedFiles", op: "isEmpty" },
      {
        path: "result.finishedAt",
        op: "before",
        value: "2026-12-01T00:00:00Z",
      },
      { path: "result.finishedAt", op: "matches", value: "^2026" },
      { path: "input.plan.summary", op: "startsWith", value: "Fix" },
      { path: "result.testsPass", op: "exists" },
      {
        path: "result.changedFiles",
        op: "some",
        where: { path: "length", op: "greaterThan", value: 3 },
      },
      {
        avg: ["result.attempts", "nodes.evaluate.result.quality"],
        weights: [1, 3],
        op: "greaterThan",
        value: 0.5,
      },
      {
        count: ["result.testsPass", "result.changedFiles"],
        op: "equal",
        value: 2,
      },
      {
        not: { any: [{ path: "result.testsPass", op: "equal", value: false }] },
      },
    ];
    for (const when of valid) {
      expect(bugWith(when)).toEqual([]);
    }
  });

  test.concurrent.each([
    [
      { path: "result.testsPass", op: "greaterThan", value: 1 },
      "/nodes/fix/next/routes/0/when/op",
      "operator_type",
    ],
    [
      { path: "result.attempts", op: "startsWith", value: "1" },
      "/nodes/fix/next/routes/0/when/op",
      "operator_type",
    ],
    [
      { path: "result.attempts", op: "before", value: "2026-01-01" },
      "/nodes/fix/next/routes/0/when/op",
      "operator_type",
    ],
    [
      { path: "result.attempts", op: "contains", value: 1 },
      "/nodes/fix/next/routes/0/when/op",
      "operator_type",
    ],
    [
      { path: "result.testsPass", op: "isEmpty" },
      "/nodes/fix/next/routes/0/when/op",
      "operator_type",
    ],
    [
      {
        path: "result.testsPass",
        op: "some",
        where: { path: "x", op: "exists" },
      },
      "/nodes/fix/next/routes/0/when/op",
      "operator_type",
    ],
    [
      { path: "result.testsPass", op: "equal", value: "yes" },
      "/nodes/fix/next/routes/0/when/value",
      "type_mismatch",
    ],
    [
      { path: "result.attempts", op: "greaterThan", value: "2" },
      "/nodes/fix/next/routes/0/when/value",
      "type_mismatch",
    ],
    [
      { path: "result.changedFiles", op: "contains", value: 3 },
      "/nodes/fix/next/routes/0/when/value",
      "type_mismatch",
    ],
    [
      { path: "result.finishedAt", op: "after", value: "yesterday" },
      "/nodes/fix/next/routes/0/when/value",
      "type_mismatch",
    ],
    [
      { path: "result.finishedAt", op: "matches", value: "(" },
      "/nodes/fix/next/routes/0/when/value",
      "invalid_condition",
    ],
    [
      {
        path: "result.attempts",
        op: "greaterThan",
        ref: "nodes.evaluate.result.summary",
      },
      "/nodes/fix/next/routes/0/when/ref",
      "operator_type",
    ],
    [
      { path: "result.testsPass", op: "equal", ref: "result.attempts" },
      "/nodes/fix/next/routes/0/when/ref",
      "operator_type",
    ],
    [
      {
        all: [
          { path: "result.testsPass", op: "exists" },
          { path: "result.nope", op: "exists" },
        ],
      },
      "/nodes/fix/next/routes/0/when/all/1/path",
      "unknown_path",
    ],
    [
      { not: { path: "result.testsPass", op: "lessThan", value: 1 } },
      "/nodes/fix/next/routes/0/when/not/op",
      "operator_type",
    ],
  ] as const)("rejects %j", (when, path, code) => {
    expect(bugWith(when)).toMatchObject([{ path, code }]);
  });

  test.concurrent("an enum field can't equal a value outside the enum", () => {
    const document = clone(bugPipeline());
    nextOf(document, "reproduce-from-session", 0)["when"] = {
      path: "result.evidenceVerdict",
      op: "equal",
      value: "yes",
    };
    expect(errorsOf(document, bugSteps)).toMatchObject([
      {
        code: "type_mismatch",
        path: "/nodes/reproduce-from-session/next/routes/0/when/value",
        message:
          '"result.evidenceVerdict" is "reproduced" | "not_reproduced" | "inconclusive", so it can never equal "yes" (string)',
      },
    ]);
  });
});

describe("list conditions and computed values", () => {
  test.concurrent(
    "accepts list conditions and computed values over a merged list",
    () => {
      const valid = [
        {
          path: "input.reviews",
          op: "every",
          where: { path: "confidence", op: "greaterThan", value: 0.5 },
        },
        {
          path: "input.reviews",
          op: "none",
          where: {
            all: [
              { path: "approved", op: "equal", value: true },
              { path: "notes", op: "isEmpty" },
            ],
          },
        },
        {
          avg: { path: "input.reviews", field: "confidence" },
          op: "lessThan",
          value: 0.8,
        },
        {
          min: { path: "input.reviews", field: "confidence" },
          op: "lessThan",
          value: 0.8,
        },
        {
          count: {
            path: "input.reviews",
            where: { path: "approved", op: "equal", value: false },
          },
          op: "greaterThan",
          value: 2,
        },
        { count: { path: "input.reviews" }, op: "greaterThan", value: 0 },
        { path: "input.reviews.length", op: "greaterThan", value: 0 },
      ];
      for (const when of valid) {
        expect(itemsWith(when)).toEqual([]);
      }
    },
  );

  test.concurrent.each([
    [
      {
        path: "input.reviews",
        op: "some",
        where: { path: "aproved", op: "equal", value: false },
      },
      "/nodes/approve-reviews/next/routes/0/when/where/path",
      "unknown_path",
    ],
    [
      {
        path: "input.reviews",
        op: "some",
        where: { path: "approved", op: "greaterThan", value: 1 },
      },
      "/nodes/approve-reviews/next/routes/0/when/where/op",
      "operator_type",
    ],
    [
      {
        avg: { path: "input.reviews", field: "notes" },
        op: "lessThan",
        value: 0.8,
      },
      "/nodes/approve-reviews/next/routes/0/when/avg/field",
      "operator_type",
    ],
    [
      {
        avg: { path: "input.reviews", field: "nope" },
        op: "lessThan",
        value: 0.8,
      },
      "/nodes/approve-reviews/next/routes/0/when/avg/field",
      "unknown_path",
    ],
    [
      { avg: { path: "input.reviews" }, op: "lessThan", value: 0.8 },
      "/nodes/approve-reviews/next/routes/0/when/avg",
      "invalid_condition",
    ],
    [
      {
        sum: {
          path: "input.reviews",
          where: { path: "approved", op: "exists" },
        },
        op: "lessThan",
        value: 1,
      },
      "/nodes/approve-reviews/next/routes/0/when/sum/where",
      "invalid_condition",
    ],
    [
      {
        count: { path: "input.reviews", field: "approved" },
        op: "lessThan",
        value: 1,
      },
      "/nodes/approve-reviews/next/routes/0/when/count/field",
      "invalid_condition",
    ],
    [
      {
        count: { path: "input.reviews", where: { path: "nope", op: "exists" } },
        op: "lessThan",
        value: 1,
      },
      "/nodes/approve-reviews/next/routes/0/when/count/where/path",
      "unknown_path",
    ],
    [
      {
        sum: { path: "nodes.plan-changes.result.summary", field: "x" },
        op: "lessThan",
        value: 1,
      },
      "/nodes/approve-reviews/next/routes/0/when/sum/path",
      "operator_type",
    ],
    [
      { count: { path: "input.reviews" }, op: "startsWith", value: "1" },
      "/nodes/approve-reviews/next/routes/0/when/op",
      "operator_type",
    ],
    [
      { count: { path: "input.reviews" }, op: "greaterThan", value: "1" },
      "/nodes/approve-reviews/next/routes/0/when/value",
      "type_mismatch",
    ],
  ] as const)("rejects %j", (when, path, code) => {
    expectError(itemsWith(when), { path, code });
  });

  test.concurrent.each([
    [
      {
        avg: ["result.attempts", "result.testsPass"],
        op: "greaterThan",
        value: 1,
      },
      "/nodes/fix/next/routes/0/when/avg/1",
      "operator_type",
    ],
    [
      { avg: ["result.attempts", "result.nope"], op: "greaterThan", value: 1 },
      "/nodes/fix/next/routes/0/when/avg/1",
      "unknown_path",
    ],
    [
      {
        avg: ["result.attempts"],
        weights: [1, 2],
        op: "greaterThan",
        value: 1,
      },
      "/nodes/fix/next/routes/0/when/weights",
      "invalid_condition",
    ],
    [
      {
        avg: ["result.attempts", "nodes.evaluate.result.quality"],
        weights: [1, -1],
        op: "greaterThan",
        value: 1,
      },
      "/nodes/fix/next/routes/0/when/weights",
      "invalid_condition",
    ],
    [
      {
        avg: ["result.attempts", "nodes.evaluate.result.quality"],
        weights: [0, 0],
        op: "greaterThan",
        value: 1,
      },
      "/nodes/fix/next/routes/0/when/weights",
      "invalid_condition",
    ],
  ] as const)("rejects computed list %j", (when, path, code) => {
    expect(bugWith(when)).toMatchObject([{ path, code }]);
  });
});

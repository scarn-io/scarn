import { describe, expect, test } from "bun:test";
import {
  describeCatch,
  describeCondition,
  describeRoute,
} from "./describe-transition";

describe("describeCondition", () => {
  test("renders comparisons with symbols and other operators by name", () => {
    expect(
      describeCondition({ path: "triage.score", op: "greaterThan", value: 3 }),
    ).toBe("triage.score > 3");
    expect(
      describeCondition({
        path: "pr.title",
        op: "contains",
        ref: "input.word",
      }),
    ).toBe("pr.title contains input.word");
    expect(describeCondition({ path: "fix.branch", op: "exists" })).toBe(
      "fix.branch exists",
    );
  });

  test("renders combinators, computed functions and list conditions", () => {
    expect(
      describeCondition({
        all: [
          { avg: ["a.score", "b.score"], op: "greaterThanInclusive", value: 7 },
          { not: { path: "a.ok", op: "equal", value: false } },
        ],
      }),
    ).toBe("avg(a.score, b.score) >= 7 and not (a.ok == false)");
    expect(
      describeCondition({
        path: "lanes",
        op: "some",
        where: { path: "item.ok", op: "equal", value: true },
      }),
    ).toBe("lanes some (item.ok == true)");
  });
});

describe("describeRoute", () => {
  test("labels a route by its condition and the fallback 'otherwise'", () => {
    expect(
      describeRoute(
        { to: "a", when: { path: "x.y", op: "equal", value: 1 } },
        "route",
      ),
    ).toBe("x.y == 1");
    expect(describeRoute({ to: "b" }, "otherwise")).toBe("otherwise");
    expect(describeRoute({ to: "b" }, "route")).toBeUndefined();
    expect(describeRoute({ to: "b" }, "start")).toBeUndefined();
  });

  test("labels a route without when on an all node 'always'", () => {
    expect(describeRoute({ to: "b" }, "route", "all")).toBe("always");
    expect(describeRoute({ to: "b" }, "route", "first")).toBeUndefined();
    expect(describeRoute({ to: "b" }, "otherwise", "all")).toBe("otherwise");
    expect(
      describeRoute(
        { to: "a", when: { path: "x.y", op: "equal", value: 1 } },
        "route",
        "all",
      ),
    ).toBe("x.y == 1");
  });

  test("labels an each route with what it runs over", () => {
    expect(
      describeRoute({ to: "a", each: { over: "result.files" } }, "route"),
    ).toBe("each over result.files");
    expect(
      describeRoute(
        { to: "a", each: { over: "result.files" } },
        "route",
        "all",
      ),
    ).toBe("always · each over result.files");
  });

  test("labels a partial route with the fields it supplies", () => {
    expect(
      describeRoute(
        { to: "m", args: { reviews: { list: ["result"] } }, partial: true },
        "route",
      ),
    ).toBe("partial: reviews");
    expect(describeRoute({ to: "m", partial: true }, "route")).toBe("partial");
  });

  test("truncates long labels", () => {
    const label = describeRoute(
      { to: "a", each: { over: `x.${"long".repeat(20)}` } },
      "route",
    );
    expect(label?.endsWith("…")).toBe(true);
    expect(label?.length).toBe(48);
  });
});

describe("describeCatch", () => {
  test("lists the caught error names", () => {
    expect(describeCatch({ on: ["A", "B"], to: "x" })).toBe("catch A, B");
  });
});

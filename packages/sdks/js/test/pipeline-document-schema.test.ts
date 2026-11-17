import { describe, expect, test } from "bun:test";
import {
  isRouteOverridable,
  pipelineDocumentJsonSchema,
  pipelineDocumentSchema,
} from "../src/contracts/pipeline-document";

type Doc = Record<string, unknown> & {
  nodes: Record<string, Record<string, unknown>>;
};

const clone = (document: object): Doc => structuredClone(document) as Doc;

const minimal = () => ({
  schemaVersion: 1,
  key: "minimal",
  start: { to: "done" },
  nodes: { done: { kind: "succeed" } },
});

describe("pipelineDocumentSchema", () => {
  test.concurrent("rejects an unknown schemaVersion", () => {
    expect(
      pipelineDocumentSchema.safeParse({ ...minimal(), schemaVersion: 2 })
        .success,
    ).toBe(false);
  });

  describe("conditions", () => {
    const withWhen = (when: object) => {
      const document = clone(minimal());
      document.nodes["s"] = {
        kind: "step",
        step: "s",
        next: {
          routes: [{ when, to: "done" }],
          otherwise: { to: "done" },
        },
      };
      return pipelineDocumentSchema.safeParse(document);
    };

    test.concurrent("accepts every documented condition form", () => {
      const forms = [
        { path: "result.a", op: "equal", value: 1 },
        { path: "result.a", op: "greaterThan", ref: "nodes.x.result.b" },
        { path: "result.a", op: "exists" },
        { all: [{ path: "result.a", op: "isEmpty" }] },
        { any: [{ path: "result.a", op: "isEmpty" }] },
        { not: { path: "result.a", op: "isEmpty" } },
        {
          path: "input.reviews",
          op: "some",
          where: { path: "approved", op: "equal", value: false },
        },
        {
          avg: ["result.a", "result.b"],
          weights: [2, 1],
          op: "greaterThan",
          value: 0.7,
        },
        {
          avg: { path: "input.reviews", field: "confidence" },
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
      ];
      for (const form of forms) {
        expect(withWhen(form).success).toBe(true);
      }
    });

    test.concurrent("rejects malformed conditions", () => {
      const invalid = [
        { op: "equal", value: 1 },
        { path: "result.a", avg: ["result.b"], op: "equal", value: 1 },
        { path: "result.a", op: "equal" },
        { path: "result.a", op: "equal", value: 1, ref: "result.b" },
        { path: "result.a", op: "exists", value: 1 },
        { path: "input.reviews", op: "some" },
        {
          path: "result.a",
          op: "equal",
          value: 1,
          where: { path: "x", op: "exists" },
        },
        { sum: ["result.a"], weights: [1], op: "equal", value: 1 },
        { all: [{ path: "result.a", op: "exists" }], path: "result.b" },
        { all: [] },
        { path: "result.a", op: "like", value: 1 },
        { path: "result.a" },
      ];
      for (const form of invalid) {
        expect(withWhen(form).success).toBe(false);
      }
    });
  });
});

describe("partial, each and list args", () => {
  const withRoute = (route: object, start: object = { to: "s" }) => {
    const document = clone(minimal());
    document["start"] = start;
    document.nodes["s"] = {
      kind: "step",
      step: "s",
      next: { routes: [route] },
    };
    document.nodes["m"] = { kind: "step", step: "m" };
    return pipelineDocumentSchema.safeParse(document);
  };

  test.concurrent("accepts partial routes and list args", () => {
    expect(
      withRoute({
        to: "m",
        partial: true,
        args: { reviews: { list: ["result", { value: 1 }] } },
      }).success,
    ).toBe(true);
  });

  test.concurrent("accepts toleratedFailures on each", () => {
    expect(
      withRoute({
        to: "m",
        each: { over: "result.files", toleratedFailures: { percent: 50 } },
      }).success,
    ).toBe(true);
  });

  test.concurrent(
    "rejects partial with each, partial on start, and join",
    () => {
      expect(
        withRoute({ to: "m", partial: true, each: { over: "result.files" } })
          .success,
      ).toBe(false);
      expect(withRoute({ to: "m" }, { to: "s", partial: true }).success).toBe(
        false,
      );
      expect(withRoute({ to: "m", join: {} }).success).toBe(false);
    },
  );
});

describe("label and overridable", () => {
  const withNext = (next: object, start: object = { to: "s" }) => {
    const document = clone(minimal());
    document["start"] = start;
    document.nodes["s"] = { kind: "step", step: "s", next };
    return pipelineDocumentSchema.safeParse(document);
  };

  test.concurrent("accepts them on routes, otherwise and next", () => {
    expect(
      withNext({
        routes: [
          {
            when: { path: "result.a", op: "exists" },
            to: "done",
            label: "Ship it",
            overridable: true,
          },
        ],
        otherwise: { to: "done", label: "Hold", overridable: true },
        overridable: true,
      }).success,
    ).toBe(true);
  });

  test.concurrent("rejects bad labels and a false overridable", () => {
    expect(withNext({ routes: [{ to: "done", label: "" }] }).success).toBe(
      false,
    );
    expect(
      withNext({ routes: [{ to: "done", label: "x".repeat(81) }] }).success,
    ).toBe(false);
    expect(
      withNext({ routes: [{ to: "done", overridable: false }] }).success,
    ).toBe(false);
    expect(
      withNext({ routes: [{ to: "done" }], overridable: false }).success,
    ).toBe(false);
  });

  test.concurrent("rejects them on start", () => {
    const next = { routes: [{ to: "done" }] };
    expect(withNext(next, { to: "s", label: "Go" }).success).toBe(false);
    expect(withNext(next, { to: "s", overridable: true }).success).toBe(false);
  });
});

describe("isRouteOverridable", () => {
  const when = { path: "result.a", op: "exists" } as const;

  test.concurrent("reads the route's own flag before next's", () => {
    const next = {
      routes: [{ when, to: "a", overridable: true as const }, { to: "b" }],
      otherwise: { to: "c" },
    };
    expect(isRouteOverridable(next, { kind: "route", index: 0 })).toBe(true);
    expect(isRouteOverridable(next, { kind: "route", index: 1 })).toBe(false);
    expect(isRouteOverridable(next, { kind: "otherwise", index: 0 })).toBe(
      false,
    );
  });

  test.concurrent("falls back to next.overridable", () => {
    const next = {
      routes: [{ when, to: "a" }],
      otherwise: { to: "c" },
      overridable: true as const,
    };
    expect(isRouteOverridable(next, { kind: "route", index: 0 })).toBe(true);
    expect(isRouteOverridable(next, { kind: "otherwise", index: 0 })).toBe(
      true,
    );
  });

  test.concurrent('skips unconditional routes under match "all"', () => {
    const next = {
      match: "all" as const,
      routes: [{ to: "a" }, { when, to: "b" }],
      otherwise: { to: "c" },
      overridable: true as const,
    };
    expect(isRouteOverridable(next, { kind: "route", index: 0 })).toBe(false);
    expect(isRouteOverridable(next, { kind: "route", index: 1 })).toBe(true);
    expect(isRouteOverridable(next, { kind: "otherwise", index: 0 })).toBe(
      true,
    );
  });

  test.concurrent("is false for an unknown route or no next", () => {
    const next = { routes: [{ to: "a" }], overridable: true as const };
    expect(isRouteOverridable(next, { kind: "route", index: 3 })).toBe(false);
    expect(isRouteOverridable(next, { kind: "otherwise", index: 0 })).toBe(
      false,
    );
    expect(isRouteOverridable(undefined, { kind: "route", index: 0 })).toBe(
      false,
    );
  });
});

describe("pipelineDocumentJsonSchema", () => {
  test.concurrent("exports a JSON Schema for editors", () => {
    const schema = pipelineDocumentJsonSchema();
    expect(schema["$schema"]).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    expect(schema["required"]).toEqual([
      "schemaVersion",
      "key",
      "start",
      "nodes",
    ]);
    expect(JSON.stringify(schema)).toContain('"decision"');
  });
});

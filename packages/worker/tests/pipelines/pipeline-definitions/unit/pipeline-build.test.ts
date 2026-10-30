import { describe, expect, test } from "bun:test";
import {
  formatLocatedValidationError,
  missingStepKeys,
  siteForPointer,
} from "../../../../src/pipelines/pipeline-definitions/domain/pipeline-build";

const site = (line: number) => ({ file: "/repo/p.ts", line, column: 1 });

const sourceMap = {
  "": site(1),
  "/nodes/review": site(10),
  "/nodes/review/next/routes/0": site(12),
};

describe("siteForPointer", () => {
  test.concurrent("uses the exact pointer when it's mapped", () => {
    expect(siteForPointer(sourceMap, "/nodes/review/next/routes/0")).toEqual(
      site(12),
    );
  });

  test.concurrent("falls back to the closest mapped ancestor", () => {
    expect(
      siteForPointer(sourceMap, "/nodes/review/next/routes/0/args/plan"),
    ).toEqual(site(12));
    expect(siteForPointer(sourceMap, "/nodes/review/title")).toEqual(site(10));
    expect(siteForPointer(sourceMap, "/start")).toEqual(site(1));
  });

  test.concurrent("is null when nothing, not even the root, is mapped", () => {
    expect(siteForPointer({}, "/nodes/x")).toBeNull();
  });
});

describe("formatLocatedValidationError", () => {
  test.concurrent(
    "prints the TS site before the pointer, with the hint",
    () => {
      expect(
        formatLocatedValidationError(sourceMap, {
          path: "/nodes/review/next/routes/0/args/plan",
          message: "missing",
          hint: "pass plan",
        }),
      ).toBe(
        "/repo/p.ts:12 (/nodes/review/next/routes/0/args/plan): missing. pass plan",
      );
    },
  );
});

describe("missingStepKeys", () => {
  test.concurrent("lists step nodes the local catalog doesn't define", () => {
    expect(
      missingStepKeys({
        key: "k",
        document: {
          nodes: {
            a: { kind: "step", step: "local" },
            b: { kind: "step", step: "remote" },
            c: { kind: "succeed" },
          },
        },
        sourceMap: {},
        steps: { local: { inputSchema: true, resultSchema: true, errors: [] } },
        warnings: [],
      }),
    ).toEqual(["remote"]);
  });
});

/**
 * Build errors: one test per row of the "build error" column in
 * docs/plans/pipeline-ts-sdk.md that `definePipeline` reports itself. The
 * rows only the validator can see (dominance, server-only steps) are tested
 * in shared-core's `sdk-golden.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import {
  decision,
  definePipeline,
  each,
  equal,
  PipelineBuildError,
  succeed,
  workItem,
  type PipelineConfig,
} from "@scarn/sdk/pipelines";
import {
  analyze,
  intake,
  summarize,
} from "../../../../../apps/docs/src/content/catalog-fixtures/pipeline-graph/steps";
import {
  editFile,
  openPr,
  planChanges,
  reviewEdit,
} from "./fixtures/items-pipeline";

function buildErrors(config: PipelineConfig): string[] {
  try {
    definePipeline(config);
  } catch (error) {
    if (error instanceof PipelineBuildError) {
      return error.message
        .split("\n")
        .slice(1)
        .map((line) => line.trim());
    }
    throw error;
  }
  throw new Error("expected a build error");
}

const done = succeed("done");

function has(text: string): string {
  return expect.stringContaining(text) as string;
}

describe("build errors", () => {
  test("print the TS location and the JSON pointer", () => {
    const [line] = buildErrors({
      key: "k",
      start: intake,
      flow: [intake.next(done), intake.next(done)],
    });
    expect(line).toMatch(
      /^test\/pipelines\/build-errors\.test\.ts:\d+ \(\/nodes\/intake-step\): "intake-step" is wired twice/,
    );
  });

  test("a node wired twice in flow", () => {
    expect(
      buildErrors({
        key: "k",
        start: intake,
        flow: [intake.next(done), intake.next(done)],
      }),
    ).toEqual([has('(/nodes/intake-step): "intake-step" is wired twice')]);
  });

  test("an each whose start is a partial target", () => {
    const errors = buildErrors({
      key: "k",
      start: planChanges({ request: workItem.title }),
      flow: [
        planChanges.next((r) =>
          each(
            r.result.files,
            () => openPr.partial({ request: r.result.summary }) as never,
          ),
        ),
      ],
    });
    expect(errors).toContainEqual(
      has(
        "(/nodes/plan-changes/next/routes/0): an each's start can't be a .partial(...) target",
      ),
    );
  });

  test('in "first" mode, a route with no when beside other routes', () => {
    const errors = buildErrors({
      key: "k",
      start: intake,
      flow: [
        intake.next({
          routes: [
            { to: analyze },
            { when: (r) => equal(r.input, {}), to: done },
          ],
        }),
        analyze.next(done),
      ],
    });
    expect(errors).toEqual([
      has(
        '(/nodes/intake-step/next/routes/0): "intake-step" has more than one route, so in "first" mode every route needs a "when"',
      ),
    ]);
  });

  test("a partial target outside .next(...)", () => {
    const errors = buildErrors({
      key: "k",
      start: openPr.partial({ request: workItem.title }) as never,
      flow: [],
    });
    expect(errors).toContainEqual(
      has("(/start): .partial(...) is only valid as a target in .next(...)"),
    );
  });

  test("an array literal holding refs compiles to a list arg", () => {
    const pipeline = definePipeline({
      key: "k",
      start: planChanges({ request: workItem.title }),
      flow: [
        planChanges.next((r) =>
          each(r.result.files, (file) =>
            editFile({ file, planSummary: r.result.summary }),
          ),
        ),
        editFile.next((r) =>
          reviewEdit({ path: r.result.path, diff: r.result.diff }),
        ),
        reviewEdit.next((r) =>
          openPr.partial({
            reviews: [r.result, { approved: true, confidence: 1, notes: "" }],
          }),
        ),
        openPr.next(done),
      ],
    });
    expect(pipeline.document.nodes["review-edit"]).toMatchObject({
      next: {
        routes: [
          {
            to: "open-pr",
            partial: true,
            args: {
              reviews: {
                list: [
                  "result",
                  { value: { approved: true, confidence: 1, notes: "" } },
                ],
              },
            },
          },
        ],
      },
    });
  });

  test("a decision with no actions", () => {
    const review = decision("review", { actions: {} });
    expect(
      buildErrors({
        key: "k",
        start: intake,
        flow: [intake.next(review), review.next(done)],
      }),
    ).toEqual([
      has('(/nodes/review/actions): decision "review" has no actions'),
    ]);
  });

  test("unreachable nodes", () => {
    expect(
      buildErrors({
        key: "k",
        start: intake,
        flow: [intake.next(done), analyze.next(done)],
      }),
    ).toEqual([has('(/nodes/analyze-step): "analyze-step" is unreachable')]);
  });

  test("a chain that was built but never put in flow is a warning", () => {
    const stray = summarize.as("stray-summary");
    stray.next(done);
    const pipeline = definePipeline({
      key: "k",
      start: stray,
      flow: [stray.next(done)],
    });
    expect(pipeline.warnings.map((warning) => warning.message)).toEqual([
      'a chain for "stray-summary" was built but never put in flow, so it has no effect',
    ]);
  });

  test("two handles with the same node id", () => {
    const other = analyze.as("intake-step");
    expect(
      buildErrors({
        key: "k",
        start: intake,
        flow: [intake.next(other), other.next(done)],
      }),
    ).toContainEqual(
      has('two different handles use the node id "intake-step"'),
    );
  });

  test("refs read but not used", () => {
    const errors = buildErrors({
      key: "k",
      start: planChanges({ request: workItem.title }),
      flow: [
        planChanges.next({
          routes: [
            {
              when: (r) => equal(r.result.count, 0),
              to: (r) =>
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, scarn/no-logic-in-pipeline-callbacks -- the mistake under test
                r.result.summary ? done : openPr({ request: "", reviews: [] }),
            },
          ],
          otherwise: done,
        }),
      ],
    });
    expect(errors).toEqual([
      has(
        '(/nodes/plan-changes/next/routes/0): "result.summary" is read but never used',
      ),
    ]);
  });

  test("the same work-item alias with two labels", async () => {
    const { workItemField } = await import("@scarn/sdk/pipelines");
    const errors = buildErrors({
      key: "k",
      start: planChanges({ request: workItemField("req", "Request") }),
      flow: [
        planChanges.next(() =>
          openPr({ request: workItemField("req", "Other"), reviews: [] }),
        ),
        openPr.next(done),
      ],
    });
    expect(errors).toEqual([
      has(
        '(/workItemFields/req): work-item field "req" is used with two labels',
      ),
    ]);
  });
});

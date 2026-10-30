/** Placeholders at run time: coercion throws, spreads expand per property, refs belong to their callback. */
import { describe, expect, test } from "bun:test";
import {
  definePipeline,
  equal,
  PipelineBuildError,
  stepRef,
  succeed,
  workItem,
  type PipelineConfig,
} from "@scarn/sdk/pipelines";
import { fix } from "./fixtures/bug-steps";
import { editFile, openPr, planChanges } from "./fixtures/items-pipeline";

const done = succeed("done");

function has(text: string): string {
  return expect.stringContaining(text) as string;
}

function messages(config: PipelineConfig): string[] {
  try {
    definePipeline(config);
  } catch (error) {
    if (error instanceof PipelineBuildError) {
      return error.issues.map((issue) => `${issue.pointer}: ${issue.message}`);
    }
    throw error;
  }
  return [];
}

describe("coercion", () => {
  test("comparisons, arithmetic and template strings throw at build time", () => {
    const cases: ((r: {
      result: { count: object; summary: object };
    }) => object)[] = [
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the mistake under test
      (r) => editFile({ file: String(r.result.summary), planSummary: "" }),
      (r) =>
        editFile({
          file: "",
          planSummary: "x" + (r.result.summary as unknown as string),
        }),
      (r) => ((r.result.count as unknown as number) > 1 ? done : done),
    ];
    for (const target of cases) {
      const errors = messages({
        key: "k",
        start: planChanges({ request: workItem.title }),
        flow: [planChanges.next(target as never), editFile.next(done)],
      });
      expect(errors.join("\n")).toContain("was coerced to a primitive");
      expect(errors.join("\n")).toContain("Use a condition helper");
    }
  });
});

describe("spread", () => {
  test("spreading a ref expands to one reference per declared input property", () => {
    const pipeline = definePipeline({
      key: "k",
      start: planChanges({ request: workItem.title }),
      flow: [
        planChanges.next((r) =>
          editFile({
            ...r.result,
            file: r.result.summary,
            planSummary: r.input.request,
          }),
        ),
        editFile.next((r) => editFile({ ...r.input })),
      ],
    });
    expect(pipeline.document.nodes["edit-file"]).toEqual({
      kind: "step",
      step: "edit-file",
      next: {
        routes: [
          {
            to: "edit-file",
            args: { file: "input.file", planSummary: "input.planSummary" },
          },
        ],
      },
    });
  });

  test("spreading a ref without a declared schema is a build error", () => {
    const remote = stepRef("remote");
    const errors = messages({
      key: "k",
      start: remote,
      flow: [
        remote.next((r) => fix({ ...(r.input as object) } as never)),
        fix.next(done),
      ],
    });
    expect(errors.join("\n")).toContain(`can't spread "input"`);
  });
});

describe("callback ownership", () => {
  test("a ref from another node's callback is a build error", () => {
    let leaked: object | undefined;
    const errors = messages({
      key: "k",
      start: planChanges({ request: workItem.title }),
      flow: [
        planChanges.next((r) => {
          leaked = r.result.summary;
          return editFile({
            file: r.result.summary,
            planSummary: r.result.summary,
          });
        }),
        editFile.next(() => openPr({ request: leaked as never, reviews: [] })),
        openPr.next(done),
      ],
    });
    expect(errors).toEqual([
      has(
        '/nodes/edit-file/next/routes/0/args/request: "result.summary" comes from another callback',
      ),
    ]);
  });
});

describe("conditions", () => {
  test("compile to JSON when objects", () => {
    const pipeline = definePipeline({
      key: "k",
      start: planChanges({ request: workItem.title }),
      flow: [
        planChanges.next({
          routes: [
            {
              when: (r) => equal(r.result.count, r.result.files.length),
              to: done,
            },
          ],
          otherwise: done,
        }),
      ],
    });
    expect(pipeline.document.nodes["plan-changes"]).toEqual({
      kind: "step",
      step: "plan-changes",
      next: {
        routes: [
          {
            when: {
              path: "result.count",
              op: "equal",
              ref: "result.files.length",
            },
            to: "done",
          },
        ],
        otherwise: { to: "done" },
      },
    });
  });
});

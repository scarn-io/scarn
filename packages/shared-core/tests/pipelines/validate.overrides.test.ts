import { describe, expect, test } from "bun:test";
import { bugPipeline, bugSteps, clone, type Doc } from "./fixtures";
import { triagePipeline, triageSteps } from "./fixtures-triage";
import { errorsOf, expectError, nextOf } from "./helpers";

function nextObject(document: Doc, id: string): Record<string, unknown> {
  return (document.nodes[id] as { next: Record<string, unknown> }).next;
}

describe("route labels and overridable", () => {
  test.concurrent("labels and overridable routes on a step are valid", () => {
    const document = clone(bugPipeline());
    nextOf(document, "evaluate", 0)["label"] = "Ask for details";
    nextOf(document, "evaluate", 1)["label"] = "Reproduce from session";
    nextOf(document, "evaluate", 1)["overridable"] = true;
    nextOf(document, "evaluate", 2)["label"] = "Reproduce from logs";
    nextObject(document, "evaluate")["overridable"] = true;
    expect(errorsOf(document, bugSteps)).toEqual([]);
  });

  test.concurrent("a duplicate label within one next is an error", () => {
    const document = clone(bugPipeline());
    nextOf(document, "evaluate", 0)["label"] = "Retry";
    nextOf(document, "evaluate", 2)["label"] = "Retry";
    expectError(errorsOf(document, bugSteps), {
      code: "schema",
      path: "/nodes/evaluate/next/otherwise/label",
      message: '"evaluate" has more than one route labelled "Retry"',
    });
  });

  test.concurrent(
    'overridable on a route without when under match "all" is an error',
    () => {
      const document = clone(triagePipeline());
      nextOf(document, "classify-issue", 0)["overridable"] = true;
      expectError(errorsOf(document, triageSteps), {
        code: "schema",
        path: "/nodes/classify-issue/next/routes/0/overridable",
      });
    },
  );

  test.concurrent(
    'next.overridable under match "all" skips unconditional routes',
    () => {
      const document = clone(triagePipeline());
      nextObject(document, "classify-issue")["overridable"] = true;
      expect(errorsOf(document, triageSteps)).toEqual([]);
    },
  );

  test.concurrent("overridable on a wait's routes is an error", () => {
    const document = clone(bugPipeline());
    nextOf(document, "ask-for-details", 0)["overridable"] = true;
    nextObject(document, "ask-for-details")["overridable"] = true;
    const errors = errorsOf(document, bugSteps);
    expectError(errors, {
      code: "schema",
      path: "/nodes/ask-for-details/next/routes/0/overridable",
    });
    expectError(errors, {
      code: "schema",
      path: "/nodes/ask-for-details/next/overridable",
    });
  });
});

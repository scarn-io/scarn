import { describe, expect, test } from "bun:test";
import { pipelineDocumentSchema } from "@scarn/sdk/contracts/pipeline-document";
import { analyzeSplits, buildGraph, splitIdOf } from "../../src/pipelines";
import { clone, type Doc } from "./fixtures";
import { itemsPipeline, itemSteps } from "./fixtures-items";
import { argsOf, errorsOf, expectError, nextOf } from "./helpers";

const PLAN_SPLIT = splitIdOf("plan-changes", "route", 0);

function analyze(document: object) {
  return analyzeSplits(buildGraph(pipelineDocumentSchema.parse(document)));
}

/** Items with a nested `each` per file: each hunk is reviewed, then merged twice. */
function nestedPipeline(): Doc {
  const document = clone(itemsPipeline());
  nextOf(document, "edit-file", 0)["each"] = { over: "result.diff.length" };
  return document;
}

describe("analyzeSplits", () => {
  test.concurrent("finds the each split, its region and its merge", () => {
    const analysis = analyze(itemsPipeline());
    expect(analysis.errors).toEqual([]);
    expect(Object.fromEntries(analysis.scopes)).toEqual({
      "plan-changes": [],
      "edit-file": [PLAN_SPLIT],
      "review-edit": [PLAN_SPLIT],
      "approve-reviews": [],
      "open-pr": [],
      done: [],
      "changes-rejected": [],
    });
    const split = analysis.splits.get(PLAN_SPLIT);
    expect(split?.merge).toBe("approve-reviews");
    expect(split?.parent).toBeNull();
    expect([...(split?.region ?? [])].sort()).toEqual([
      "edit-file",
      "review-edit",
    ]);
    const merge = analysis.merges.get("approve-reviews");
    expect(merge?.closes).toEqual([PLAN_SPLIT]);
    expect([...(merge?.fields.keys() ?? [])]).toEqual(["reviews"]);
  });

  test.concurrent(
    "a merge from nested lanes closes both splits (a cascading close)",
    () => {
      const analysis = analyze(nestedPipeline());
      const inner = splitIdOf("edit-file", "route", 0);
      expect(analysis.errors).toEqual([]);
      expect(analysis.scopes.get("review-edit")).toEqual([PLAN_SPLIT, inner]);
      expect(analysis.splits.get(inner)?.parent).toBe(PLAN_SPLIT);
      expect(analysis.merges.get("approve-reviews")?.closes).toEqual([
        inner,
        PLAN_SPLIT,
      ]);
      expect(analysis.scopes.get("approve-reviews")).toEqual([]);
    },
  );

  test.concurrent(
    "a merge that itself ends with a partial route stays in the outer lane",
    () => {
      const document = nestedPipeline();
      nextOf(document, "review-edit", 0)["to"] = "edit-file-merge";
      document.nodes["edit-file-merge"] = {
        kind: "step",
        step: "review-edit",
        next: {
          routes: [
            {
              to: "approve-reviews",
              args: { reviews: { list: ["result"] } },
              partial: true,
            },
          ],
        },
      };
      (nextOf(document, "review-edit", 0)["args"] as Record<string, unknown>) =
        { path: { list: ["input.path"] } };
      const analysis = analyze(document);
      const inner = splitIdOf("edit-file", "route", 0);
      expect(analysis.merges.get("edit-file-merge")?.closes).toEqual([inner]);
      expect(analysis.scopes.get("edit-file-merge")).toEqual([PLAN_SPLIT]);
      expect(analysis.merges.get("approve-reviews")?.closes).toEqual([
        PLAN_SPLIT,
      ]);
    },
  );
});

describe("split rules", () => {
  test.concurrent("the items pipeline is valid", () => {
    expect(errorsOf(itemsPipeline(), itemSteps)).toEqual([]);
  });

  test.concurrent("a node can't run both inside and outside a split", () => {
    const document = clone(itemsPipeline());
    (document.nodes["plan-changes"] as { next: object }).next = {
      routes: [
        {
          when: { path: "result.files.length", op: "equal", value: 1 },
          to: "edit-file",
          args: { file: "result.files.0", planSummary: "result.summary" },
        },
      ],
      otherwise: {
        to: "edit-file",
        each: { over: "result.files" },
        args: { file: "item", planSummary: "result.summary" },
      },
    };
    expectError(errorsOf(document, itemSteps), {
      code: "split",
      path: "/nodes/plan-changes/next/otherwise/to",
      messageIncludes: "can't run both inside and outside a split's lanes",
    });
  });

  test.concurrent("a partial route must come from inside a split", () => {
    const document = clone(itemsPipeline());
    delete nextOf(document, "plan-changes", 0)["each"];
    argsOf(document, "plan-changes", 0)["file"] = "result.summary";
    expectError(errorsOf(document, itemSteps), {
      code: "split",
      path: "/nodes/review-edit/next/routes/0/partial",
    });
  });

  test.concurrent("every route into a merge must be partial", () => {
    const document = clone(itemsPipeline());
    (document.nodes["edit-file"] as { next: object }).next = {
      routes: [
        {
          when: { path: "result.diff", op: "isEmpty" },
          to: "approve-reviews",
          args: { reviews: { value: [] } },
        },
      ],
      otherwise: {
        to: "review-edit",
        args: { path: "result.path", diff: "result.diff" },
      },
    };
    expectError(errorsOf(document, itemSteps), {
      code: "split",
      path: "/nodes/edit-file/next/routes/0",
      messageIncludes: "every route into it must be",
    });
  });

  test.concurrent(
    "a merge must close its split: lanes can't get around it",
    () => {
      const document = clone(itemsPipeline());
      (document.nodes["edit-file"] as { next: object }).next = {
        routes: [
          {
            when: { path: "result.diff", op: "isEmpty" },
            to: "open-pr",
            args: { request: "result.path", reviews: { value: [] } },
          },
        ],
        otherwise: {
          to: "review-edit",
          args: { path: "result.path", diff: "result.diff" },
        },
      };
      expectError(errorsOf(document, itemSteps), {
        code: "split",
        path: "/nodes/review-edit/next/routes/0/to",
        messageIncludes: "doesn't close the split",
      });
    },
  );

  test.concurrent("a merge field from item lanes must be an array", () => {
    const document = clone(itemsPipeline());
    nextOf(document, "review-edit", 0)["to"] = "open-pr";
    nextOf(document, "review-edit", 0)["args"] = {
      request: "input.path",
      reviews: { list: ["result"] },
    };
    delete (document.nodes as Record<string, unknown>)["approve-reviews"];
    expectError(errorsOf(document, itemSteps), {
      code: "split",
      path: "/nodes/review-edit/next/routes/0/args/request",
      messageIncludes: "must take it as an array",
    });
  });

  test.concurrent(
    "a merge's required fields must be supplied by its partial routes",
    () => {
      const document = clone(itemsPipeline());
      nextOf(document, "review-edit", 0)["to"] = "open-pr";
      expectError(errorsOf(document, itemSteps), {
        code: "missing_arg",
        path: "/nodes/review-edit/next/routes/0/args/request",
        messageIncludes: 'no "partial" route into it supplies it',
      });
    },
  );

  test.concurrent("list elements must fit the field's items", () => {
    const document = clone(itemsPipeline());
    nextOf(document, "review-edit", 0)["to"] = "open-pr";
    nextOf(document, "review-edit", 0)["args"] = {
      reviews: { list: ["result.notes", { value: 1 }] },
    };
    const listErrors = errorsOf(document, itemSteps).filter((error) =>
      error.path.includes("/args/reviews/list/"),
    );
    expect(listErrors).toMatchObject([
      {
        code: "type_mismatch",
        path: "/nodes/review-edit/next/routes/0/args/reviews/list/0",
      },
      {
        code: "type_mismatch",
        path: "/nodes/review-edit/next/routes/0/args/reviews/list/1/value",
      },
    ]);
  });

  test.concurrent(
    "after a merge, references can't reach into per-item nodes",
    () => {
      const document = clone(itemsPipeline());
      argsOf(document, "approve-reviews", 0)["request"] =
        "nodes.edit-file.input.planSummary";
      expect(errorsOf(document, itemSteps)).toEqual([
        {
          code: "split",
          path: "/nodes/approve-reviews/next/routes/0/args/request",
          message: `"edit-file" runs in a split's lanes, and this reference is evaluated after they merged`,
          hint: 'Pass per-item values to the merge with a "partial" route, then read them from "input"',
        },
      ]);
    },
  );

  test.concurrent(
    "inside a lane, reaching back to earlier per-item and top-level nodes is fine",
    () => {
      const document = clone(itemsPipeline());
      argsOf(document, "edit-file", 0)["path"] =
        "nodes.plan-changes.result.summary";
      argsOf(document, "edit-file", 0)["diff"] = "nodes.edit-file.input.file";
      expect(errorsOf(document, itemSteps)).toEqual([]);
    },
  );

  test.concurrent("each.over must be an array reference", () => {
    const document = clone(itemsPipeline());
    nextOf(document, "plan-changes", 0)["each"] = { over: "result.summary" };
    expectError(errorsOf(document, itemSteps), {
      code: "type_mismatch",
      path: "/nodes/plan-changes/next/routes/0/each/over",
    });
    nextOf(document, "plan-changes", 0)["each"] = { over: "result.nope" };
    expectError(errorsOf(document, itemSteps), {
      code: "unknown_path",
      path: "/nodes/plan-changes/next/routes/0/each/over",
    });
  });

  test.concurrent("item is typed as the element of each.over", () => {
    const document = clone(itemsPipeline());
    argsOf(document, "plan-changes", 0)["file"] = "item.name";
    expect(errorsOf(document, itemSteps)).toMatchObject([
      {
        code: "unknown_path",
        path: "/nodes/plan-changes/next/routes/0/args/file",
      },
    ]);
  });

  test.concurrent("the start transition can't use each", () => {
    const document = clone(itemsPipeline());
    (document["start"] as Record<string, unknown>)["each"] = {
      over: "workItem.title",
    };
    expectError(errorsOf(document, itemSteps), {
      code: "split",
      path: "/start/each",
    });
  });

  test.concurrent("a route can't both each and partial", () => {
    const document = clone(itemsPipeline());
    nextOf(document, "review-edit", 0)["each"] = { over: "input.path" };
    expectError(errorsOf(document, itemSteps), {
      code: "schema",
      path: "/nodes/review-edit/next/routes/0/partial",
    });
  });
});

import { describe, expect, test } from "bun:test";
import { bugPipeline, bugSteps, clone } from "./fixtures";
import { itemsPipeline, itemSteps } from "./fixtures-items";
import { argsOf, errorsOf, expectError, nextOf, stepOf } from "./helpers";

describe("reference paths", () => {
  test.concurrent(
    "reports a path missing from the result schema with a spelling hint",
    () => {
      const document = clone(bugPipeline());
      argsOf(document, "evaluate", 1)["evaluation"] = "result.qualty";
      expect(errorsOf(document, bugSteps)).toContainEqual({
        code: "unknown_path",
        path: "/nodes/evaluate/next/routes/1/args/evaluation",
        message:
          '"result.qualty" doesn\'t exist: "evaluate"\'s result (EvaluateResult) has no "qualty"',
        hint: 'Did you mean "result.quality"?',
      });
    },
  );

  test.concurrent("lists the available fields when nothing is close", () => {
    const document = clone(bugPipeline());
    argsOf(document, "failing-test", 0)["evaluation"] =
      "nodes.evaluate.result.zzzzzzzz";
    const error = errorsOf(document, bugSteps).find(
      (entry) => entry.code === "unknown_path",
    );
    expect(error?.hint).toBe(
      '"nodes.evaluate.result" has "quality", "hasRumSession", "maxAttempts", "summary", "missingDetails"',
    );
  });

  test.concurrent("checks nested input paths", () => {
    const document = clone(bugPipeline());
    argsOf(document, "fix", 1)["plan"] = "input.plan.nope";
    expect(errorsOf(document, bugSteps)).toMatchObject([
      { code: "unknown_path", path: "/nodes/fix/next/otherwise/args/plan" },
    ]);
  });

  test.concurrent("allows .length and array indexes", () => {
    const document = clone(itemsPipeline());
    argsOf(document, "plan-changes", 0)["file"] = "result.files.0";
    argsOf(document, "plan-changes", 0)["planSummary"] = "result.summary";
    expect(errorsOf(document, itemSteps)).toEqual([]);
    nextOf(document, "plan-changes", 0)["when"] = {
      path: "result.files.length",
      op: "greaterThan",
      value: 0,
    };
    nextOf(document, "plan-changes", 0)["each"] = { over: "result.files" };
    (
      document.nodes["plan-changes"] as { next: { otherwise: object } }
    ).next.otherwise = {
      to: "done",
    };
    expect(errorsOf(document, itemSteps)).toEqual([]);
  });

  test.concurrent(
    "rejects a string that isn't a reference with a { value } hint",
    () => {
      const document = clone(bugPipeline());
      argsOf(document, "evaluate", 1)["companyNames"] = "Acme";
      const errors = errorsOf(document, bugSteps);
      expect(errors).toHaveLength(1);
      expectError(errors, {
        code: "invalid_reference",
        path: "/nodes/evaluate/next/routes/1/args/companyNames",
        hintIncludes: '{ "value": "Acme" }',
      });
    },
  );

  test.concurrent("workItem.fields aliases must be declared", () => {
    const document = clone(bugPipeline());
    (document["start"] as { args: Record<string, unknown> }).args[
      "companyNames"
    ] = "workItem.fields.companyName";
    expect(errorsOf(document, bugSteps)).toMatchObject([
      {
        code: "unknown_path",
        path: "/start/args/companyNames",
        hint: 'Did you mean "workItem.fields.companyNames"?',
      },
    ]);
  });

  test.concurrent("decision wait results are { action, body }", () => {
    const document = clone(bugPipeline());
    nextOf(document, "approve-fix", 0)["when"] = {
      path: "result.acton",
      op: "equal",
      value: "approve",
    };
    expect(errorsOf(document, bugSteps)).toMatchObject([
      {
        code: "unknown_path",
        path: "/nodes/approve-fix/next/routes/0/when/path",
        hint: 'Did you mean "result.action"?',
      },
    ]);
  });
});

describe("where item and error may appear", () => {
  test.concurrent(
    "the start transition only takes work-item data and literals",
    () => {
      const document = clone(bugPipeline());
      (document["start"] as { args: Record<string, unknown> }).args[
        "companyNames"
      ] = "result.x";
      expect(errorsOf(document, bugSteps)).toMatchObject([
        { code: "reference_not_allowed", path: "/start/args/companyNames" },
      ]);
    },
  );

  test.concurrent(
    "item is only allowed in the args of an each transition",
    () => {
      const document = clone(itemsPipeline());
      argsOf(document, "edit-file", 0)["path"] = "item";
      expect(errorsOf(document, itemSteps)).toMatchObject([
        {
          code: "reference_not_allowed",
          path: "/nodes/edit-file/next/routes/0/args/path",
          hint: '"item" is only available in the args of a transition with "each"',
        },
      ]);
    },
  );

  test.concurrent("results isn't a reference", () => {
    const document = clone(itemsPipeline());
    argsOf(document, "edit-file", 0)["path"] = "results";
    expectError(errorsOf(document, itemSteps), {
      path: "/nodes/edit-file/next/routes/0/args/path",
    });
  });

  test.concurrent(
    "a partial route reads its own node's result and input",
    () => {
      const document = clone(itemsPipeline());
      argsOf(document, "review-edit", 0)["paths"] = {
        list: ["input.path", "nodes.edit-file.result.path"],
      };
      expect(errorsOf(document, itemSteps)).toEqual([]);
    },
  );

  test.concurrent("error is only allowed in catch, where result is not", () => {
    const document = clone(bugPipeline());
    argsOf(document, "evaluate", 1)["evaluation"] = "error";
    expect(errorsOf(document, bugSteps)).toMatchObject([
      {
        code: "reference_not_allowed",
        path: "/nodes/evaluate/next/routes/1/args/evaluation",
      },
    ]);

    const withCatch = clone(bugPipeline());
    const steps = {
      ...bugSteps,
      "failing-test": {
        ...stepOf(bugSteps, "failing-test"),
        inputSchema: {
          type: "object",
          properties: {
            evaluation: true,
            investigation: true,
            reason: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    };
    (withCatch.nodes["reproduce-from-logs"] as Record<string, unknown>)[
      "catch"
    ] = [
      {
        on: ["Scarn.All"],
        to: "failing-test",
        args: { reason: "error.message", evaluation: "input.evaluation" },
      },
    ];
    expect(errorsOf(withCatch, steps)).toEqual([]);
    (withCatch.nodes["reproduce-from-logs"] as Record<string, unknown>)[
      "catch"
    ] = [
      {
        on: ["Scarn.All"],
        to: "failing-test",
        args: { reason: "result.evidenceVerdict" },
      },
    ];
    expect(errorsOf(withCatch, steps)).toMatchObject([
      {
        code: "reference_not_allowed",
        path: "/nodes/reproduce-from-logs/catch/0/args/reason",
      },
    ]);
  });
});

import { describe, expect, test } from "bun:test";
import type { JsonSchema } from "@scarn/sdk/contracts/pipeline-document";
import { obj } from "./fixture-schema";
import { bugPipeline, bugSteps, clone } from "./fixtures";
import { itemsPipeline, itemSteps } from "./fixtures-items";
import {
  argsOf,
  errorsOf,
  expectError,
  findError,
  nextOf,
  stepOf,
} from "./helpers";

describe("args against step inputs", () => {
  test.concurrent(
    "reports a missing arg with the spec's message and a did-you-mean hint",
    () => {
      const document = clone(bugPipeline());
      delete argsOf(document, "fix", 1)["plan"];
      const errors = errorsOf(document, bugSteps);
      expect(errors).toEqual([
        {
          code: "missing_arg",
          path: "/nodes/fix/next/otherwise/args/plan",
          message: 'missing; "fix" requires plan (ProposeFixResult)',
          hint: 'Did you mean "input.plan"?',
        },
      ]);
    },
  );

  test.concurrent("suggests a reach-back when nothing local fits", () => {
    const document = clone(itemsPipeline());
    delete argsOf(document, "approve-reviews", 0)["request"];
    const error = findError(
      errorsOf(document, itemSteps),
      "/nodes/approve-reviews/next/routes/0/args/request",
    );
    expect(error?.hint).toBe(
      'Did you mean "nodes.plan-changes.input.request"?',
    );
  });

  test.concurrent("optional inputs may be left out", () => {
    const document = clone(bugPipeline());
    expect(
      argsOf(document, "propose-fix", 1)["previousAttempt"],
    ).toBeUndefined();
    expect(errorsOf(document, bugSteps)).toEqual([]);
  });

  test.concurrent("reports extra args with a spelling hint", () => {
    const document = clone(bugPipeline());
    argsOf(document, "evaluate", 1)["evalution"] = "result";
    argsOf(document, "evaluate", 1)["unrelated"] = "result";
    const errors = errorsOf(document, bugSteps);
    expect(
      findError(errors, "/nodes/evaluate/next/routes/1/args/evalution"),
    ).toMatchObject({
      code: "extra_arg",
      message: '"reproduce-from-session" has no input "evalution"',
    });
    expect(
      findError(errors, "/nodes/evaluate/next/routes/1/args/unrelated")?.hint,
    ).toBe('Its inputs are "companyNames", "employeeEmails", "evaluation"');
  });

  test.concurrent("args to succeed and fail nodes are extras", () => {
    const document = clone(bugPipeline());
    (
      document.nodes["reproduce-from-session"] as {
        next: { otherwise: object };
      }
    ).next.otherwise = {
      to: "not-reproduced",
      args: { why: "result.evidenceVerdict" },
    };
    expect(errorsOf(document, bugSteps)).toMatchObject([
      {
        code: "extra_arg",
        path: "/nodes/reproduce-from-session/next/otherwise/args/why",
      },
    ]);
  });

  test.concurrent("reports a type mismatch with a hint", () => {
    const document = clone(bugPipeline());
    argsOf(document, "fix", 1)["plan"] = "input.failingTest";
    expect(errorsOf(document, bugSteps)).toEqual([
      {
        code: "type_mismatch",
        path: "/nodes/fix/next/otherwise/args/plan",
        message:
          '"input.failingTest" is FailingTestResult, but "fix" needs "plan" to be ProposeFixResult',
        hint: 'Did you mean "input.plan"?',
      },
    ]);
  });

  test.concurrent("reports scalar type mismatches", () => {
    const document = clone(bugPipeline());
    argsOf(document, "evaluate", 1)["companyNames"] =
      "nodes.evaluate.result.quality";
    expect(errorsOf(document, bugSteps)).toMatchObject([
      {
        code: "type_mismatch",
        path: "/nodes/evaluate/next/routes/1/args/companyNames",
        message:
          '"nodes.evaluate.result.quality" is number, but "reproduce-from-session" needs "companyNames" to be string',
      },
    ]);
  });

  test.concurrent(
    "workItem.description is allowed in start and is string | null",
    () => {
      const withDescription = (description: JsonSchema) => ({
        ...bugSteps,
        evaluate: {
          ...stepOf(bugSteps, "evaluate"),
          inputSchema: obj(
            "EvaluateInput",
            {
              companyNames: { type: "string" },
              employeeEmails: { type: "string" },
              description,
            },
            ["companyNames", "employeeEmails"],
          ),
        },
      });
      const document = clone(bugPipeline());
      (document["start"] as { args: Record<string, unknown> }).args[
        "description"
      ] = "workItem.description";

      expect(
        errorsOf(document, withDescription({ type: ["string", "null"] })),
      ).toEqual([]);
      expect(
        errorsOf(document, withDescription({ type: "string" })),
      ).toMatchObject([
        { code: "type_mismatch", path: "/start/args/description" },
      ]);
    },
  );

  test.concurrent("checks literal args against the input schema", () => {
    const document = clone(bugPipeline());
    (document["start"] as { args: Record<string, unknown> }).args[
      "companyNames"
    ] = { value: 42 };
    (document["start"] as { args: Record<string, unknown> }).args[
      "employeeEmails"
    ] = { value: "a@b.c" };
    expect(errorsOf(document, bugSteps)).toMatchObject([
      {
        code: "type_mismatch",
        path: "/start/args/companyNames/value",
        message: '42 doesn\'t fit "companyNames" (string)',
      },
    ]);
  });

  test.concurrent(
    "an enum result field fits a string input, but not the reverse",
    () => {
      const steps = {
        ...bugSteps,
        "failing-test": {
          ...stepOf(bugSteps, "failing-test"),
          inputSchema: {
            type: "object",
            properties: {
              evaluation: true,
              investigation: true,
              verdict: { enum: ["reproduced"] },
            },
            required: ["evaluation", "investigation"],
            additionalProperties: false,
          },
        },
      };
      const document = clone(bugPipeline());
      argsOf(document, "reproduce-from-session", 0)["verdict"] =
        "result.evidenceVerdict";
      expect(errorsOf(document, steps)).toMatchObject([
        {
          code: "type_mismatch",
          path: "/nodes/reproduce-from-session/next/routes/0/args/verdict",
        },
      ]);
    },
  );

  test.concurrent(
    "a list of results fits an array-of-results input; a single result doesn't",
    () => {
      const document = clone(itemsPipeline());
      nextOf(document, "review-edit", 0)["to"] = "open-pr";
      argsOf(document, "review-edit", 0)["request"] = { list: ["input.path"] };
      delete (document.nodes as Record<string, unknown>)["approve-reviews"];
      delete (document.nodes as Record<string, unknown>)["changes-rejected"];
      expect(
        errorsOf(document, itemSteps).filter(
          (error) => !error.path.endsWith("/args/request"),
        ),
      ).toEqual([]);
      argsOf(document, "review-edit", 0)["reviews"] = "result";
      expectError(errorsOf(document, itemSteps), {
        code: "type_mismatch",
        path: "/nodes/review-edit/next/routes/0/args/reviews",
      });
    },
  );

  test.concurrent(
    "wait inputs are what every incoming transition passes",
    () => {
      const document = clone(itemsPipeline());
      argsOf(document, "approve-reviews", 0)["request"] = "input.request";
      const errors = errorsOf(document, itemSteps);
      expect(errors).toHaveLength(1);
      expectError(errors, {
        code: "unknown_path",
        path: "/nodes/approve-reviews/next/routes/0/args/request",
        messageIncludes: '"input.request" doesn\'t exist',
      });
    },
  );

  test.concurrent("$ref-based step schemas are followed", () => {
    const steps = {
      ...itemSteps,
      "edit-file": {
        ...stepOf(itemSteps, "edit-file"),
        inputSchema: {
          $ref: "#/$defs/Input",
          $defs: {
            Input: {
              type: "object",
              properties: {
                file: { $ref: "#/$defs/Path" },
                planSummary: { type: "string" },
              },
              required: ["file", "planSummary"],
              additionalProperties: false,
            },
            Path: { type: "string" },
          },
        },
      },
    };
    expect(errorsOf(itemsPipeline(), steps)).toEqual([]);
    const document = clone(itemsPipeline());
    argsOf(document, "plan-changes", 0)["file"] = "result.count";
    expect(errorsOf(document, steps)).toMatchObject([
      {
        code: "type_mismatch",
        path: "/nodes/plan-changes/next/routes/0/args/file",
      },
    ]);
  });

  test.concurrent("reports an unknown step key", () => {
    const document = clone(bugPipeline());
    (document.nodes["fix"] as Record<string, unknown>)["step"] = "fixx";
    expect(errorsOf(document, bugSteps)).toEqual([
      {
        code: "unknown_step",
        path: "/nodes/fix/step",
        message: 'No step definition "fixx"',
        hint: 'Did you mean "fix"?',
      },
    ]);
  });
});

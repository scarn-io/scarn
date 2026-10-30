import { describe, expect, test } from "bun:test";
import {
  pipelineDocumentSchema,
  REPLY_RESULT_SCHEMA,
  WAIT_ERRORS,
} from "@scarn/sdk/contracts/pipeline-document";
import { buildGraph } from "../../src/pipelines";
import { bugPipeline, bugSteps, clone, type Doc } from "./fixtures";
import { decisionPipeline, decisionSteps } from "./fixtures-decision";
import { obj } from "./fixture-schema";
import { argsOf, errorsOf, expectError, nextOf, stepOf } from "./helpers";

function nodeOf(document: Doc, id: string): Record<string, unknown> {
  const node = document.nodes[id];
  if (node === undefined) {
    throw new Error(`fixture node "${id}" is missing`);
  }
  return node;
}

function setWaitCatch(document: ReturnType<typeof clone>, catches: object[]) {
  (document.nodes["ask-for-details"] as Record<string, unknown>)["catch"] =
    catches;
}

describe("reply waits", () => {
  test.concurrent("the bug pipeline with a reply wait is valid", () => {
    expect(errorsOf(bugPipeline(), bugSteps)).toEqual([]);
  });

  test.concurrent("wait catch targets are graph edges", () => {
    const graph = buildGraph(pipelineDocumentSchema.parse(bugPipeline()));
    expect(
      graph.edges.filter((edge) => edge.from === "ask-for-details"),
    ).toMatchObject([
      { to: "evaluate", kind: "route" },
      { to: "insufficient-detail", kind: "catch" },
    ]);
  });

  test.concurrent("wait catch targets are checked", () => {
    const document = clone(bugPipeline());
    setWaitCatch(document, [
      { on: ["Scarn.MaxRunsExceeded"], to: "insuficient-detail" },
    ]);
    const errors = errorsOf(document, bugSteps);
    expectError(errors, {
      code: "unknown_node",
      path: "/nodes/ask-for-details/catch/0/to",
      hint: 'Did you mean "insufficient-detail"?',
    });
    expectError(errors, {
      code: "unreachable_node",
      path: "/nodes/insufficient-detail",
    });
  });

  test.concurrent("wait catch args are checked against the target", () => {
    const document = clone(bugPipeline());
    setWaitCatch(document, [
      {
        on: ["Scarn.MaxRunsExceeded"],
        to: "insufficient-detail",
        args: { why: "error.message" },
      },
    ]);
    expect(errorsOf(document, bugSteps)).toMatchObject([
      { code: "extra_arg", path: "/nodes/ask-for-details/catch/0/args/why" },
    ]);
  });

  test.concurrent.each(WAIT_ERRORS.map((name) => [name]))(
    "a wait catch may name %s",
    (name) => {
      const document = clone(bugPipeline());
      setWaitCatch(document, [{ on: [name], to: "insufficient-detail" }]);
      expect(errorsOf(document, bugSteps)).toEqual([]);
    },
  );

  test.concurrent.each([
    ["Scarn.StepFailed", undefined],
    ["Scarn.Timeout", undefined],
    ["Scarn.HeartbeatTimeout", undefined],
    ["Scarn.ConditionError", undefined],
    ["Scarn.MaxTurnsExceeded", undefined],
    ["LogsUnavailable", undefined],
    ["Scarn.MaxRunExceeded", 'Did you mean "Scarn.MaxRunsExceeded"?'],
  ] as const)("a wait catch can't name %s", (name, hint) => {
    const document = clone(bugPipeline());
    setWaitCatch(document, [{ on: [name], to: "insufficient-detail" }]);
    expectError(errorsOf(document, bugSteps), {
      code: "unknown_error_name",
      path: "/nodes/ask-for-details/catch/0/on/0",
      message: `A wait node can't raise "${name}"`,
      ...(hint === undefined ? {} : { hint }),
    });
  });

  test.concurrent("a step catch can name Scarn.MaxTurnsExceeded", () => {
    const document = clone(bugPipeline());
    (document.nodes["fix"] as Record<string, unknown>)["catch"] = [
      { on: ["Scarn.MaxTurnsExceeded"], to: "fix-rejected" },
    ];
    expect(errorsOf(document, bugSteps)).toEqual([]);
  });

  test.concurrent("a step catch can name Scarn.ArgsError", () => {
    const document = clone(bugPipeline());
    (document.nodes["fix"] as Record<string, unknown>)["catch"] = [
      { on: ["Scarn.ArgsError"], to: "fix-rejected" },
    ];
    expect(errorsOf(document, bugSteps)).toEqual([]);
  });

  test.concurrent("a transition into a reply wait must pass questions", () => {
    const document = clone(bugPipeline());
    delete argsOf(document, "evaluate", 0)["questions"];
    expect(errorsOf(document, bugSteps)).toMatchObject([
      {
        code: "missing_arg",
        path: "/nodes/evaluate/next/routes/0/args/questions",
        message:
          'missing; reply wait "ask-for-details" requires questions (string[])',
      },
    ]);
  });

  test.concurrent("questions must be a string[]", () => {
    const document = clone(bugPipeline());
    argsOf(document, "evaluate", 0)["questions"] = "result.summary";
    expect(errorsOf(document, bugSteps)).toMatchObject([
      {
        code: "type_mismatch",
        path: "/nodes/evaluate/next/routes/0/args/questions",
      },
    ]);

    argsOf(document, "evaluate", 0)["questions"] = { value: [1, 2] };
    expect(errorsOf(document, bugSteps)).toMatchObject([
      {
        code: "type_mismatch",
        path: "/nodes/evaluate/next/routes/0/args/questions/value",
      },
    ]);

    argsOf(document, "evaluate", 0)["questions"] = {
      value: ["What browser?"],
    };
    expect(errorsOf(document, bugSteps)).toEqual([]);
  });

  test.concurrent("reply wait results are { replied, body, commentId }", () => {
    expect(REPLY_RESULT_SCHEMA).toMatchObject({
      required: ["replied", "body", "commentId"],
    });
    const document = clone(bugPipeline());
    nextOf(document, "ask-for-details", 0)["when"] = {
      path: "result.replyed",
      op: "equal",
      value: true,
    };
    (
      document.nodes["ask-for-details"] as { next: { otherwise: object } }
    ).next.otherwise = {
      to: "insufficient-detail",
    };
    expect(errorsOf(document, bugSteps)).toMatchObject([
      {
        code: "unknown_path",
        path: "/nodes/ask-for-details/next/routes/0/when/path",
        hint: 'Did you mean "result.replied"?',
      },
    ]);
  });

  test.concurrent("actions on a reply wait are rejected", () => {
    const document = clone(bugPipeline());
    nodeOf(document, "ask-for-details")["actions"] = [
      { key: "approve", label: "Approve" },
    ];
    expect(errorsOf(document, bugSteps)).toMatchObject([
      {
        code: "schema",
        path: "/nodes/ask-for-details/actions",
        message:
          '"actions" is only allowed on a "decision" wait, not a "reply" wait',
      },
    ]);
  });
});

describe("decision waits", () => {
  test.concurrent("the review loop is valid", () => {
    expect(errorsOf(decisionPipeline(), decisionSteps)).toEqual([]);
  });

  test.concurrent("a decision wait without actions is rejected", () => {
    const document = decisionPipeline();
    delete nodeOf(document, "review-fix")["actions"];
    expect(errorsOf(document, decisionSteps)).toMatchObject([
      {
        code: "schema",
        path: "/nodes/review-fix/actions",
        message: 'decision wait "review-fix" needs at least one action',
      },
    ]);
  });

  test.concurrent("a decision wait with no actions is rejected", () => {
    const document = decisionPipeline();
    nodeOf(document, "review-fix")["actions"] = [];
    expectError(errorsOf(document, decisionSteps), {
      code: "schema",
      path: "/nodes/review-fix/actions",
    });
  });

  test.concurrent("duplicate action keys are rejected", () => {
    const document = decisionPipeline();
    nodeOf(document, "review-fix")["actions"] = [
      { key: "approve", label: "Approve" },
      { key: "revise", label: "Request changes" },
      { key: "approve", label: "Ship it" },
    ];
    expect(errorsOf(document, decisionSteps)).toMatchObject([
      {
        code: "schema",
        path: "/nodes/review-fix/actions/2/key",
        message:
          'decision wait "review-fix" has more than one action "approve"',
      },
    ]);
  });

  test.concurrent("an action body is optional or required", () => {
    const document = decisionPipeline();
    nodeOf(document, "review-fix")["actions"] = [
      { key: "approve", label: "Approve", body: "sometimes" },
    ];
    expectError(errorsOf(document, decisionSteps), {
      code: "schema",
      path: "/nodes/review-fix/actions/0/body",
    });
  });

  test.concurrent("decision is a supported wait", () => {
    const document = decisionPipeline();
    nodeOf(document, "review-fix")["for"] = "event";
    delete nodeOf(document, "review-fix")["actions"];
    expectError(errorsOf(document, decisionSteps), {
      code: "not_in_v1",
      path: "/nodes/review-fix/for",
      hintIncludes: 'only "decision" and "reply" waits are supported',
    });
  });

  test.concurrent("result.action equal to an unknown key never matches", () => {
    const document = decisionPipeline();
    nextOf(document, "review-fix", 0)["when"] = {
      path: "result.action",
      op: "equal",
      value: "aprove",
    };
    expect(errorsOf(document, decisionSteps)).toMatchObject([
      {
        code: "type_mismatch",
        path: "/nodes/review-fix/next/routes/0/when/value",
        message:
          '"result.action" is "approve" | "revise" | "reject", so it can never equal "aprove" (string)',
      },
    ]);
  });

  test.concurrent("decision wait results are { action, body }", () => {
    const document = decisionPipeline();
    nextOf(document, "review-fix", 0)["when"] = {
      path: "result.approved",
      op: "equal",
      value: true,
    };
    expectError(errorsOf(document, decisionSteps), {
      code: "unknown_path",
      path: "/nodes/review-fix/next/routes/0/when/path",
    });
  });

  test.concurrent("result.body is a string | null", () => {
    const document = decisionPipeline();
    expect(argsOf(document, "review-fix", 1)["feedback"]).toBe("result.body");
    expect(errorsOf(document, decisionSteps)).toEqual([]);
    argsOf(document, "review-fix", 1)["title"] = "result.body";
    expectError(errorsOf(document, decisionSteps), {
      code: "type_mismatch",
      path: "/nodes/review-fix/next/routes/1/args/title",
    });
  });

  test.concurrent("result.body fits a string | null written as anyOf", () => {
    const proposeFix = stepOf(decisionSteps, "propose-fix");
    const steps = {
      ...decisionSteps,
      "propose-fix": {
        ...proposeFix,
        inputSchema: obj(
          "ProposeFixInput",
          {
            title: { type: "string" },
            feedback: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
          ["title"],
        ),
      },
    };
    expect(errorsOf(decisionPipeline(), steps)).toEqual([]);
  });
});

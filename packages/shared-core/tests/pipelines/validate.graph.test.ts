import { describe, expect, test } from "bun:test";
import { pipelineDocumentSchema } from "@scarn/sdk/contracts/pipeline-document";
import { buildGraph, dominates, dominatorsOf } from "../../src/pipelines";
import { bugPipeline, bugSteps, clone } from "./fixtures";
import { argsOf, errorsOf, expectError, nextOf } from "./helpers";

describe("nodes and transitions", () => {
  test.concurrent("every to must exist", () => {
    const document = clone(bugPipeline());
    nextOf(document, "fix", 0)["to"] = "dne";
    expect(errorsOf(document, bugSteps)).toContainEqual({
      code: "unknown_node",
      path: "/nodes/fix/next/routes/0/to",
      message: '"dne" is not a node in this pipeline',
      hint: 'Did you mean "done"?',
    });
  });

  test.concurrent("every node must be reachable", () => {
    const document = clone(bugPipeline());
    document.nodes["orphan"] = { kind: "succeed" };
    expect(errorsOf(document, bugSteps)).toEqual([
      {
        code: "unreachable_node",
        path: "/nodes/orphan",
        message: '"orphan" can\'t be reached from "start"',
        hint: "Add a transition to it, or remove it",
      },
    ]);
  });

  test.concurrent("a step or wait without next is valid", () => {
    const document = clone(bugPipeline());
    delete document.nodes["ask-for-details"]?.["next"];
    expect(errorsOf(document, bugSteps)).toEqual([]);
  });

  test.concurrent("next needs at least one route", () => {
    const document = clone(bugPipeline());
    (document.nodes["approve-fix"] as { next: { routes: unknown[] } }).next = {
      routes: [],
    };
    expectError(errorsOf(document, bugSteps), {
      path: "/nodes/approve-fix/next/routes",
    });
  });

  test.concurrent("match is first or all", () => {
    const document = clone(bugPipeline());
    (document.nodes["approve-fix"] as { next: Record<string, unknown> }).next[
      "match"
    ] = "any";
    expectError(errorsOf(document, bugSteps), {
      path: "/nodes/approve-fix/next/match",
    });
  });

  test.concurrent("a lone route may leave out when", () => {
    const document = clone(bugPipeline());
    const node = document.nodes["fix"] as {
      next: { routes: Record<string, unknown>[]; otherwise?: object };
    };
    node.next = { routes: [{ to: "done" }] };
    expect(errorsOf(document, bugSteps)).toEqual([]);
  });

  test.concurrent("a route without when must be the only route", () => {
    const document = clone(bugPipeline());
    delete nextOf(document, "evaluate", 0)["when"];
    expect(errorsOf(document, bugSteps)).toMatchObject([
      { code: "route_without_when", path: "/nodes/evaluate/next/routes/0" },
    ]);
  });

  test.concurrent("otherwise can't have when", () => {
    const document = clone(bugPipeline());
    nextOf(document, "fix", 1)["when"] = {
      path: "result.testsPass",
      op: "equal",
      value: false,
    };
    expect(errorsOf(document, bugSteps)).toMatchObject([
      {
        code: "schema",
        path: "/nodes/fix/next/otherwise",
        message: 'Unknown key "when"',
      },
    ]);
  });
});

describe("reach-back dominance (checkReachBacks)", () => {
  test.concurrent(
    "reaching back to a node not on every path is rejected with candidates",
    () => {
      const document = clone(bugPipeline());
      argsOf(document, "failing-test", 0)["investigation"] =
        "nodes.reproduce-from-session.result";
      expect(errorsOf(document, bugSteps)).toEqual([
        {
          code: "reach_back",
          path: "/nodes/failing-test/next/routes/0/args/investigation",
          message:
            '"reproduce-from-session" doesn\'t run on every path to "failing-test", so "nodes.reproduce-from-session.result" may not exist',
          hint: 'Reach back to a node that runs on every path to "failing-test" ("evaluate"), or pass the value along in args',
        },
      ]);
    },
  );

  test.concurrent(
    "reaching back through a loop is fine when the node dominates",
    () => {
      const document = clone(bugPipeline());
      argsOf(document, "fix", 1)["plan"] = "nodes.propose-fix.result";
      expect(errorsOf(document, bugSteps)).toEqual([]);
    },
  );

  test.concurrent("a node can reach back to itself", () => {
    const document = clone(bugPipeline());
    argsOf(document, "fix", 1)["previousAttempt"] = "nodes.fix.result";
    expect(errorsOf(document, bugSteps)).toEqual([]);
  });

  test.concurrent(
    "unknown and terminal reach-back targets are reported",
    () => {
      const document = clone(bugPipeline());
      argsOf(document, "fix", 1)["plan"] = "nodes.propose-fixx.result";
      argsOf(document, "fix", 1)["evaluation"] = "nodes.done.result";
      const errors = errorsOf(document, bugSteps);
      expectError(errors, {
        code: "unknown_node",
        path: "/nodes/fix/next/otherwise/args/plan",
        hint: 'Did you mean "nodes.propose-fix.result"?',
      });
      expectError(errors, {
        code: "reach_back",
        path: "/nodes/fix/next/otherwise/args/evaluation",
      });
    },
  );

  test.concurrent(
    "a node's result isn't available on paths through its own catch",
    () => {
      const document = clone(bugPipeline());
      (document.nodes["reproduce-from-logs"] as Record<string, unknown>)[
        "catch"
      ] = [
        {
          on: ["Scarn.All"],
          to: "ask-for-details",
          args: { questions: "input.evaluation.missingDetails" },
        },
      ];
      (document.nodes["ask-for-details"] as { next: object }).next = {
        routes: [
          {
            when: {
              path: "nodes.reproduce-from-logs.result.reproductionConfidence",
              op: "greaterThan",
              value: 0,
            },
            to: "insufficient-detail",
          },
        ],
        otherwise: { to: "insufficient-detail" },
      };
      document.nodes["evaluate"] = {
        kind: "step",
        step: "evaluate",
        next: {
          routes: [
            {
              to: "reproduce-from-logs",
              args: {
                companyNames: "input.companyNames",
                employeeEmails: "input.employeeEmails",
                evaluation: "result",
              },
            },
          ],
        },
      };
      delete document.nodes["reproduce-from-session"];
      const errors = errorsOf(document, bugSteps);
      expectError(errors, {
        code: "reach_back",
        path: "/nodes/ask-for-details/next/routes/0/when/path",
        hintIncludes: '"nodes.reproduce-from-logs.input"',
      });
    },
  );

  test.concurrent("a catch can't read its own node's result", () => {
    const document = clone(bugPipeline());
    (document.nodes["reproduce-from-logs"] as Record<string, unknown>)[
      "catch"
    ] = [
      {
        on: ["Scarn.All"],
        to: "failing-test",
        args: {
          evaluation: "input.evaluation",
          investigation: "nodes.reproduce-from-logs.result",
        },
      },
    ];
    expectError(errorsOf(document, bugSteps), {
      code: "reach_back",
      path: "/nodes/reproduce-from-logs/catch/0/args/investigation",
    });
  });

  test.concurrent("the start transition can't reach back", () => {
    const document = clone(bugPipeline());
    (document["start"] as { args: Record<string, unknown> }).args[
      "companyNames"
    ] = "nodes.evaluate.input.companyNames";
    expect(errorsOf(document, bugSteps)).toMatchObject([
      { code: "reference_not_allowed", path: "/start/args/companyNames" },
    ]);
  });

  test.concurrent(
    "dominators of a node are computed over next and catch edges",
    () => {
      const graph = buildGraph(pipelineDocumentSchema.parse(bugPipeline()));
      expect(dominatorsOf(graph, "fix")).toEqual([
        "evaluate",
        "failing-test",
        "propose-fix",
      ]);
      expect(dominatorsOf(graph, "not-reproduced")).toEqual(["evaluate"]);
      expect(dominates(graph, "propose-fix", "approve-fix")).toBe(true);
      expect(dominates(graph, "approve-fix", "fix")).toBe(false);
    },
  );
});

describe("catch.on and retry.on names", () => {
  test.concurrent("accepts built-in and declared errors", () => {
    const document = clone(bugPipeline());
    (document.nodes["fix"] as Record<string, unknown>)["retry"] = [
      {
        on: ["MergeConflict", "Scarn.Timeout", "Scarn.HealthCheckFailed"],
        maxAttempts: 2,
      },
    ];
    (document.nodes["fix"] as Record<string, unknown>)["catch"] = [
      {
        on: [
          "Scarn.MaxRunsExceeded",
          "Scarn.ConditionError",
          "Scarn.StepFailed",
          "Scarn.HealthCheckFailed",
        ],
        to: "fix-rejected",
      },
    ];
    expect(errorsOf(document, bugSteps)).toEqual([]);
  });

  test.concurrent("rejects undeclared error names with a hint", () => {
    const document = clone(bugPipeline());
    (document.nodes["reproduce-from-logs"] as Record<string, unknown>)[
      "catch"
    ] = [{ on: ["LogUnavailable"], to: "not-reproduced" }];
    (document.nodes["fix"] as Record<string, unknown>)["retry"] = [
      { on: ["Scarn.HeartbeatTimout"], maxAttempts: 2 },
    ];
    const errors = errorsOf(document, bugSteps);
    expect(errors).toContainEqual({
      code: "unknown_error_name",
      path: "/nodes/reproduce-from-logs/catch/0/on/0",
      message:
        'Step "reproduce-from-logs" doesn\'t declare an error "LogUnavailable"',
      hint: 'Did you mean "LogsUnavailable"?',
    });
    expectError(errors, {
      path: "/nodes/fix/retry/0/on/0",
      hint: 'Did you mean "Scarn.HeartbeatTimeout"?',
    });
  });
});

describe("not in v1", () => {
  test.concurrent.each([
    [
      "wait for event",
      (d: ReturnType<typeof clone>) => {
        (d.nodes["approve-fix"] as Record<string, unknown>)["for"] = "event";
      },
      "/nodes/approve-fix/for",
    ],
    [
      "wait for timer",
      (d: ReturnType<typeof clone>) => {
        (d.nodes["approve-fix"] as Record<string, unknown>)["for"] = "timer";
      },
      "/nodes/approve-fix/for",
    ],
    [
      "wait timeoutSeconds",
      (d: ReturnType<typeof clone>) => {
        (d.nodes["approve-fix"] as Record<string, unknown>)["timeoutSeconds"] =
          60;
      },
      "/nodes/approve-fix/timeoutSeconds",
    ],
    [
      "pipeline timeoutSeconds",
      (d: ReturnType<typeof clone>) => {
        d["timeoutSeconds"] = 60;
      },
      "/timeoutSeconds",
    ],
    [
      "retry maxDelaySeconds",
      (d: ReturnType<typeof clone>) => {
        (d.nodes["fix"] as Record<string, unknown>)["retry"] = [
          { on: ["Scarn.All"], maxAttempts: 1, maxDelaySeconds: 5 },
        ];
      },
      "/nodes/fix/retry/0/maxDelaySeconds",
    ],
    [
      "routing in next",
      (d: ReturnType<typeof clone>) => {
        nextOf(d, "fix", 0)["pipeline"] = "other";
      },
      "/nodes/fix/next/routes/0/pipeline",
    ],
    [
      "routing in catch",
      (d: ReturnType<typeof clone>) => {
        const [handler] = (
          d.nodes["reproduce-from-logs"] as {
            catch: [Record<string, unknown>];
          }
        ).catch;
        handler["pipeline"] = "other";
      },
      "/nodes/reproduce-from-logs/catch/0/pipeline",
    ],
  ] as const)("rejects %s", (_name, mutate, path) => {
    const document = clone(bugPipeline());
    mutate(document);
    const errors = errorsOf(document, bugSteps);
    expectError(errors, { code: "not_in_v1", path });
    expect(errors.find((error) => error.path === path)?.hint).toBeDefined();
  });
});

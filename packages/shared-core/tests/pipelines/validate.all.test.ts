import { describe, expect, test } from "bun:test";
import { pipelineDocumentSchema } from "@scarn/sdk/contracts/pipeline-document";
import {
  allSplitIdOf,
  analyzeSplits,
  buildGraph,
  splitIdOf,
} from "../../src/pipelines";
import { triagePipeline, triageSteps } from "./fixtures-triage";
import { errorsOf, expectError, nextOf } from "./helpers";

const TRIAGE = allSplitIdOf("classify-issue");
const SCREENSHOTS = splitIdOf("classify-issue", "route", 2);

function analyze(document: object) {
  return analyzeSplits(buildGraph(pipelineDocumentSchema.parse(document)));
}

describe("analyzeSplits with match: all", () => {
  test.concurrent("the example is valid", () => {
    expect(errorsOf(triagePipeline(), triageSteps)).toEqual([]);
  });

  test.concurrent("an all split has a route per route plus otherwise", () => {
    const analysis = analyze(triagePipeline());
    const split = analysis.splits.get(TRIAGE);
    expect(split?.kind).toBe("all");
    expect([...(split?.routes.keys() ?? [])]).toEqual([
      "classify-issue:route:0",
      "classify-issue:route:1",
      "classify-issue:route:2",
      "classify-issue:route:3",
      "classify-issue:otherwise:0",
    ]);
    expect(split?.merge).toBe("summarise");
    expect(analysis.splits.get(SCREENSHOTS)?.parent).toBe(TRIAGE);
  });

  test.concurrent(
    "origins follow routes, and a merge's origin is the union",
    () => {
      const analysis = analyze(triagePipeline());
      expect(analysis.origins.get("reproduce-in-browser")).toEqual([
        "classify-issue:route:0",
      ]);
      expect(analysis.origins.get("security-sign-off")).toEqual([
        "classify-issue:route:1",
      ]);
      expect(analysis.origins.get("write-failing-test")).toEqual([
        "classify-issue:route:0",
        "classify-issue:route:1",
      ]);
      expect(analysis.scopes.get("write-failing-test")).toEqual([TRIAGE]);
    },
  );

  test.concurrent(
    "a partial merge stays in the split; a closing merge cascades",
    () => {
      const analysis = analyze(triagePipeline());
      expect(analysis.merges.get("write-failing-test")).toMatchObject({
        closes: [],
        partialOf: TRIAGE,
      });
      expect(analysis.merges.get("summarise")).toMatchObject({
        closes: [SCREENSHOTS, TRIAGE],
        partialOf: null,
      });
      expect(analysis.scopes.get("summarise")).toEqual([]);
      expect(analysis.scopes.get("open-pr")).toEqual([
        allSplitIdOf("summarise"),
      ]);
    },
  );

  test.concurrent(
    "a field is guaranteed despite a path to fail; item fields always are",
    () => {
      const fields = analyze(triagePipeline()).merges.get("summarise")?.fields;
      expect(fields?.get("failingTest")?.guaranteed).toBe(true);
      expect(fields?.get("screenshots")).toMatchObject({
        fromEach: true,
        guaranteed: true,
      });
    },
  );

  test.concurrent(
    "a field supplied only by a conditional route isn't guaranteed",
    () => {
      const fields =
        analyze(triagePipeline()).merges.get("write-failing-test")?.fields;
      expect(fields?.get("securityNotes")?.guaranteed).toBe(false);
    },
  );

  test.concurrent(
    "a field isn't guaranteed when a path ends quietly before supplying it",
    () => {
      const document = triagePipeline();
      delete nextOf(document, "reproduce-in-browser", 1)["args"];
      nextOf(document, "reproduce-in-browser", 1)["to"] = "link-duplicates";
      nextOf(document, "reproduce-in-browser", 1)["args"] = {
        ids: { value: [] },
      };
      const merge = analyze(document).merges.get("summarise");
      expect(merge?.fields.get("failingTest")?.guaranteed).toBe(false);
      expect(
        analyze(document)
          .merges.get("write-failing-test")
          ?.fields.get("observedBehavior")?.guaranteed,
      ).toBe(false);
      expectError(errorsOf(document, triageSteps), {
        code: "missing_arg",
        path: "/nodes/reproduce-in-browser/next/routes/0/args/observedBehavior",
        messageIncludes: "might not arrive",
        hint: 'Make "observedBehavior" optional, or supply it on every path',
      });
    },
  );
});

describe("match: all build errors", () => {
  test.concurrent("routes with no when are allowed in all mode", () => {
    const document = triagePipeline();
    const routes = (
      document.nodes["summarise"]?.["next"] as {
        routes: unknown[];
      }
    ).routes;
    expect(routes).toHaveLength(3);
    expect(errorsOf(document, triageSteps)).toEqual([]);
  });

  test.concurrent("in first mode, a route with no when beside others", () => {
    const document = triagePipeline();
    delete (document.nodes["summarise"]?.["next"] as Record<string, unknown>)[
      "match"
    ];
    expectError(errorsOf(document, triageSteps), {
      code: "route_without_when",
      path: "/nodes/summarise/next/routes/0",
    });
  });

  test.concurrent("lanes from two routes meeting without partial", () => {
    const document = triagePipeline();
    nextOf(document, "notify-security", 0)["to"] = "reproduce-in-browser";
    nextOf(document, "notify-security", 0)["args"] = {
      appUrl: "input.summary",
    };
    expectError(errorsOf(document, triageSteps), {
      code: "split",
      path: "/nodes/classify-issue/next/routes/0/to",
      messageIncludes:
        'Lanes from different routes of "classify-issue" meet at "reproduce-in-browser" without "partial"',
    });
  });

  test.concurrent("a field supplied by two different routes", () => {
    const document = triagePipeline();
    nextOf(document, "security-sign-off", 0)["args"] = {
      observedBehavior: "result.body",
    };
    expectError(errorsOf(document, triageSteps), {
      code: "split",
      path: "/nodes/security-sign-off/next/routes/0/args/observedBehavior",
      messageIncludes: "is already supplied to",
    });
  });

  test.concurrent("a required field no route supplies", () => {
    const document = triagePipeline();
    nextOf(document, "capture-screenshot", 0)["args"] = {};
    expectError(errorsOf(document, triageSteps), {
      code: "missing_arg",
      messageIncludes: 'no "partial" route into it supplies it',
      path: "/nodes/capture-screenshot/next/routes/0/args/screenshots",
    });
  });

  test.concurrent("a partial route outside any split", () => {
    const document = triagePipeline();
    delete (
      document.nodes["classify-issue"]?.["next"] as Record<string, unknown>
    )["match"];
    expectError(errorsOf(document, triageSteps), {
      code: "split",
      path: "/nodes/reproduce-in-browser/next/routes/0/partial",
    });
  });

  test.concurrent("a merge with a plain incoming route", () => {
    const document = triagePipeline();
    delete nextOf(document, "security-sign-off", 0)["partial"];
    expectError(errorsOf(document, triageSteps), {
      code: "split",
      path: "/nodes/security-sign-off/next/routes/0",
      messageIncludes: "every route into it must be",
    });
  });

  test.concurrent("a field from item lanes that isn't an array", () => {
    const document = triagePipeline();
    nextOf(document, "capture-screenshot", 0)["args"] = {
      failingTest: "result.url",
    };
    expectError(errorsOf(document, triageSteps), {
      code: "split",
      path: "/nodes/capture-screenshot/next/routes/0/args/failingTest",
    });
  });

  test.concurrent("a node reached inside and outside a split", () => {
    const document = triagePipeline();
    document.nodes["link-duplicates"] = {
      ...document.nodes["link-duplicates"],
      next: {
        routes: [{ to: "classify-issue", args: { title: { value: "again" } } }],
      },
    };
    expectError(errorsOf(document, triageSteps), {
      code: "split",
      path: "/nodes/link-duplicates/next/routes/0/to",
      messageIncludes: `"classify-issue" is reached inside 1 level of lanes ("${TRIAGE}") here but outside any split elsewhere`,
    });
  });

  test.concurrent("reaching into lane nodes after the closing merge", () => {
    const document = triagePipeline();
    const classify = document.nodes["classify-issue"]?.["next"] as {
      routes: unknown[];
      otherwise?: unknown;
    };
    classify.routes = classify.routes.slice(0, 1);
    delete classify.otherwise;
    nextOf(document, "reproduce-in-browser", 1)["to"] = "summarise";
    nextOf(document, "reproduce-in-browser", 1)["partial"] = true;
    nextOf(document, "reproduce-in-browser", 1)["args"] = {
      screenshots: { value: [] },
    };
    nextOf(document, "reproduce-in-browser", 0)["to"] = "summarise";
    nextOf(document, "reproduce-in-browser", 0)["args"] = {
      screenshots: { value: [] },
    };
    const removed = new Set([
      "notify-security",
      "security-sign-off",
      "capture-screenshot",
      "link-duplicates",
      "add-to-backlog",
      "write-failing-test",
      "not-reproduced",
    ]);
    document.nodes = Object.fromEntries(
      Object.entries(document.nodes).filter(([id]) => !removed.has(id)),
    );
    nextOf(document, "summarise", 1)["when"] = {
      path: "nodes.reproduce-in-browser.result.reproduced",
      op: "equal",
      value: true,
    };
    const errors = errorsOf(document, triageSteps);
    expect(errors).toHaveLength(1);
    expectError(errors, {
      code: "split",
      path: "/nodes/summarise/next/routes/1/when/path",
      messageIncludes: `"reproduce-in-browser" runs in a split's lanes, and this reference is evaluated after they merged`,
    });
  });

  test.concurrent(
    "a shared succeed node is exempt from the origin rules",
    () => {
      const document = triagePipeline();
      document.nodes["done"] = { kind: "succeed" };
      (document.nodes["link-duplicates"] as Record<string, unknown>)["next"] = {
        routes: [{ to: "done" }],
      };
      (document.nodes["add-to-backlog"] as Record<string, unknown>)["next"] = {
        routes: [{ to: "done" }],
      };
      (document.nodes["open-pr"] as Record<string, unknown>)["next"] = {
        routes: [{ to: "done" }],
      };
      expect(errorsOf(document, triageSteps)).toEqual([]);
    },
  );
});

/**
 * Golden tests: each TS pipeline compiles to exactly its JSON fixture, key
 * order included. The bug and items fixtures are copies of shared-core's
 * `fixtures.ts` / `fixtures-items.ts` (the SDK can't import shared-core); the
 * catalog fixtures (TS and JSON) live in the docs, which render both.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  definePipeline,
  equal,
  succeed,
  type PipelineDefinition,
} from "@scarn/sdk/pipelines";
import bugPipeline from "./fixtures/bug-pipeline";
import decisionPipeline from "./fixtures/decision-pipeline";
import issueTriagePipeline from "./fixtures/issue-triage";
import itemsPipeline from "./fixtures/items-pipeline";
import decisionCatalogPipeline from "../../../../../apps/docs/src/content/catalog-fixtures/pipeline-graph/decision";
import choicePipeline from "../../../../../apps/docs/src/content/catalog-fixtures/pipeline-graph/choice";
import lanesPipeline from "../../../../../apps/docs/src/content/catalog-fixtures/pipeline-graph/lanes";
import linearChainPipeline from "../../../../../apps/docs/src/content/catalog-fixtures/pipeline-graph/linear-chain";
import loopAndCatchPipeline from "../../../../../apps/docs/src/content/catalog-fixtures/pipeline-graph/loop-and-catch";
import routesAllPipeline from "../../../../../apps/docs/src/content/catalog-fixtures/pipeline-graph/routes-all";
import {
  analyze,
  classify,
  fileTicket,
  intake,
  pageOncall,
} from "../../../../../apps/docs/src/content/catalog-fixtures/pipeline-graph/steps";

const CATALOG_DIR = join(
  import.meta.dir,
  "../../../../../apps/docs/src/content/catalog-fixtures/pipeline-graph",
);

function readJson(path: string): string {
  return JSON.stringify(JSON.parse(readFileSync(path, "utf8")), null, 2);
}

const cases: [string, PipelineDefinition, string][] = [
  ["bug", bugPipeline, join(import.meta.dir, "expected/bug-pipeline.json")],
  [
    "items",
    itemsPipeline,
    join(import.meta.dir, "expected/items-pipeline.json"),
  ],
  [
    "issue-triage",
    issueTriagePipeline,
    join(import.meta.dir, "expected/issue-triage.json"),
  ],
  [
    "decision",
    decisionPipeline,
    join(import.meta.dir, "expected/decision-pipeline.json"),
  ],
  [
    "catalog decision",
    decisionCatalogPipeline,
    join(CATALOG_DIR, "decision.json"),
  ],
  ["catalog choice", choicePipeline, join(CATALOG_DIR, "choice.json")],
  [
    "catalog linear-chain",
    linearChainPipeline,
    join(CATALOG_DIR, "linear-chain.json"),
  ],
  [
    "catalog loop-and-catch",
    loopAndCatchPipeline,
    join(CATALOG_DIR, "loop-and-catch.json"),
  ],
  ["catalog lanes", lanesPipeline, join(CATALOG_DIR, "lanes.json")],
  [
    "catalog routes-all",
    routesAllPipeline,
    join(CATALOG_DIR, "routes-all.json"),
  ],
];

describe("golden pipelines", () => {
  for (const [name, pipeline, path] of cases) {
    test(`${name} compiles to its JSON fixture, in key order`, () => {
      expect(pipeline._tag).toBe("pipeline_document");
      expect(pipeline.key).toBe(pipeline.document.key);
      expect(JSON.stringify(pipeline.document, null, 2)).toBe(readJson(path));
      expect(pipeline.warnings).toEqual([]);
    });
  }

  test("the local catalog holds each local step's contract", () => {
    expect(Object.keys(bugPipeline.steps).sort()).toEqual([
      "evaluate",
      "failing-test",
      "fix",
      "propose-fix",
      "reproduce-from-logs",
      "reproduce-from-session",
    ]);
    expect(bugPipeline.steps["fix"]?.errors).toEqual(["MergeConflict"]);
    expect(choicePipeline.steps["page-oncall-step"]?.inputSchema).toBe(true);
  });

  test("the source map points JSON pointers at the TS source", () => {
    const site = bugPipeline.sourceMap["/nodes/fix/next/otherwise"];
    expect(site?.file.endsWith("fixtures/bug-pipeline.ts")).toBe(true);
    expect(bugPipeline.sourceMap["/start"]?.line).toBeGreaterThan(0);
    expect(bugPipeline.sourceMap["/nodes/ask-for-details"]?.file).toContain(
      "bug-pipeline.ts",
    );
  });
});

describe("next routes", () => {
  const done = succeed("done");

  test(".next(target) compiles to one route", () => {
    const pipeline = definePipeline({
      key: "k",
      start: intake,
      flow: [intake.next(analyze), analyze.next(done)],
    });
    expect(pipeline.document.nodes["intake-step"]).toEqual({
      kind: "step",
      step: "intake-step",
      next: { routes: [{ to: "analyze-step" }] },
    });
  });

  test("a step with no chain compiles to a node with no next", () => {
    const pipeline = definePipeline({
      key: "k",
      start: intake,
      flow: [intake.next(analyze)],
    });
    expect(pipeline.document.nodes["analyze-step"]).toEqual({
      kind: "step",
      step: "analyze-step",
    });
  });

  test("routes and otherwise compile in order, leaving out match", () => {
    const pipeline = definePipeline({
      key: "k",
      start: classify,
      flow: [
        classify.next({
          match: "first",
          routes: [
            {
              when: (r) => equal(r.result.severity, "critical"),
              to: pageOncall,
            },
          ],
          otherwise: fileTicket,
        }),
        pageOncall.next(done),
        fileTicket.next(done),
      ],
    });
    expect(pipeline.document.nodes["classify-step"]).toMatchObject({
      next: {
        routes: [
          {
            when: { path: "result.severity", op: "equal", value: "critical" },
            to: "page-oncall-step",
          },
        ],
        otherwise: { to: "file-ticket-step" },
      },
    });
    expect(pipeline.document.nodes["classify-step"]).not.toHaveProperty(
      "next.match",
    );
  });

  test('match: "all" compiles to the JSON, with routes that have no when', () => {
    const pipeline = definePipeline({
      key: "k",
      start: classify,
      flow: [
        classify.next({
          match: "all",
          routes: [
            { to: pageOncall },
            {
              when: (r) => equal(r.result.severity, "critical"),
              to: fileTicket,
            },
          ],
        }),
      ],
    });
    expect(pipeline.document.nodes["classify-step"]).toEqual({
      kind: "step",
      step: "classify-step",
      next: {
        match: "all",
        routes: [
          { to: "page-oncall-step" },
          {
            when: { path: "result.severity", op: "equal", value: "critical" },
            to: "file-ticket-step",
          },
        ],
      },
    });
  });
});

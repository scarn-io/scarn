/**
 * The SDK's golden TS pipelines (packages/sdks/js/test/pipelines/fixtures),
 * which import only `@scarn/sdk/...` public paths, pass `validatePipeline`
 * with their local step catalog. Also covers the build-error rows that only
 * the validator can see: dominance (`r.node(x)` where `x` may not have run)
 * and steps only the server catalog knows (`stepRef`).
 */
import { describe, expect, test } from "bun:test";
import {
  definePipeline,
  equal,
  stepRef,
  succeed,
  type PipelineDefinition,
} from "@scarn/sdk/pipelines";
import { formatValidationError, validatePipeline } from "../../src/pipelines";
import bugPipeline from "../../../sdks/js/test/pipelines/fixtures/bug-pipeline";
import decisionPipeline from "../../../sdks/js/test/pipelines/fixtures/decision-pipeline";
import issueTriagePipeline from "../../../sdks/js/test/pipelines/fixtures/issue-triage";
import itemsPipeline from "../../../sdks/js/test/pipelines/fixtures/items-pipeline";
import decisionCatalogPipeline from "../../../../apps/docs/src/content/catalog-fixtures/pipeline-graph/decision";
import choicePipeline from "../../../../apps/docs/src/content/catalog-fixtures/pipeline-graph/choice";
import lanesPipeline from "../../../../apps/docs/src/content/catalog-fixtures/pipeline-graph/lanes";
import linearChainPipeline from "../../../../apps/docs/src/content/catalog-fixtures/pipeline-graph/linear-chain";
import loopAndCatchPipeline from "../../../../apps/docs/src/content/catalog-fixtures/pipeline-graph/loop-and-catch";
import routesAllPipeline from "../../../../apps/docs/src/content/catalog-fixtures/pipeline-graph/routes-all";
import {
  analyze,
  classify,
  intake,
} from "../../../../apps/docs/src/content/catalog-fixtures/pipeline-graph/steps";

const pipelines: PipelineDefinition[] = [
  bugPipeline,
  itemsPipeline,
  issueTriagePipeline,
  decisionPipeline,
  decisionCatalogPipeline,
  choicePipeline,
  linearChainPipeline,
  loopAndCatchPipeline,
  lanesPipeline,
  routesAllPipeline,
];

function errorsOf(pipeline: PipelineDefinition): string[] {
  const result = validatePipeline(pipeline.document, pipeline.steps);
  return result.ok ? [] : result.errors.map(formatValidationError);
}

describe("SDK golden pipelines", () => {
  for (const pipeline of pipelines) {
    test(`${pipeline.key} passes validatePipeline with its local catalog`, () => {
      expect(errorsOf(pipeline)).toEqual([]);
    });
  }
});

describe("build errors the validator reports", () => {
  test("r.node(x) where x didn't run on every path", () => {
    const done = succeed("done");
    const pipeline = definePipeline({
      key: "k",
      start: classify,
      flow: [
        classify.next({
          routes: [
            { when: (r) => equal(r.result.severity, "critical"), to: intake },
          ],
          otherwise: analyze,
        }),
        intake.next(analyze),
        analyze.next({
          routes: [{ when: (r) => equal(r.node(intake).result, {}), to: done }],
          otherwise: done,
        }),
      ],
    });
    expect(errorsOf(pipeline).join("\n")).toContain("intake-step");
  });

  test("a stepRef step the local catalog doesn't know", () => {
    const remote = stepRef("server-only");
    const pipeline = definePipeline({
      key: "k",
      start: remote,
      flow: [remote.next(succeed("done"))],
    });
    expect(pipeline.steps).toEqual({});
    expect(errorsOf(pipeline).join("\n")).toContain("server-only");
  });
});

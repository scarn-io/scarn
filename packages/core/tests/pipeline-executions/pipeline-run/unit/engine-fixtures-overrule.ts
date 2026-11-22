import type {
  JsonSchema,
  StepCatalog,
} from "@scarn/sdk/contracts/pipeline-document";
import { DecideError } from "@/pipeline-executions/pipeline-run/domain/engine/types";
import { obj } from "./engine-fixture-schema";
import { bugPipeline, bugSteps, clone, type Doc } from "./engine-fixtures";

const reproduceResult = bugSteps["reproduce-from-logs"]?.resultSchema;
const failingTest = bugSteps["failing-test"];
const failingTestInput = failingTest?.inputSchema as {
  properties: Record<string, JsonSchema>;
};

export const reproductionSteps: StepCatalog = {
  ...bugSteps,
  "report-reproduction": {
    inputSchema: obj("ReportReproductionInput", {
      investigation: reproduceResult as JsonSchema,
    }),
    resultSchema: obj(
      "ReportReproductionResult",
      { summary: { type: "string" }, notes: { type: "string" } },
      ["summary"],
    ),
    errors: [],
  },
  "failing-test": {
    ...(failingTest as NonNullable<typeof failingTest>),
    inputSchema: obj(
      "FailingTestInput",
      { ...failingTestInput.properties, notes: { type: "string" } },
      ["evaluation", "investigation"],
    ),
  },
};
/**
 * The bug pipeline with `report-reproduction` between `reproduce-from-logs`
 * and its routes: a judgement call, so both routes are overridable.
 */
export function reproductionPipeline(): Doc {
  const document = clone(bugPipeline());
  (document.nodes["reproduce-from-logs"] as Record<string, unknown>)["next"] = {
    routes: [{ to: "report-reproduction", args: { investigation: "result" } }],
  };
  document.nodes["report-reproduction"] = {
    kind: "step",
    step: "report-reproduction",
    next: {
      overridable: true,
      routes: [
        {
          label: "Reproduced",
          when: {
            path: "input.investigation.reproductionConfidence",
            op: "greaterThanInclusive",
            value: 0.8,
          },
          to: "failing-test",
          args: {
            evaluation: "nodes.evaluate.result",
            investigation: "input.investigation",
            notes: "result.notes",
          },
        },
      ],
      otherwise: { label: "Not reproduced", to: "not-reproduced" },
    },
  };
  return document;
}

export function refusal(fn: () => unknown): DecideError {
  try {
    fn();
  } catch (error) {
    if (error instanceof DecideError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a DecideError");
}

export type Json = Record<string, unknown>;

export function nextOf(
  document: Doc,
  nodeId: string,
): Json & { routes: Json[] } {
  return document.nodes[nodeId]?.["next"] as Json & { routes: Json[] };
}

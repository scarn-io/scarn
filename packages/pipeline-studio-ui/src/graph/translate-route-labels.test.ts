import { describe, expect, test } from "bun:test";
import type { PipelineDocument } from "@scarn/sdk/contracts/pipeline-document";
import { translateDocumentToGraph } from "./translate-spec-to-graph";

const OVERRULE_PIPELINE: PipelineDocument = {
  schemaVersion: 1,
  key: "overrule",
  start: { to: "a" },
  nodes: {
    a: {
      kind: "step",
      step: "a",
      next: {
        routes: [
          {
            when: { path: "result.ok", op: "equal", value: true },
            to: "b",
            label: "Looks good",
            overridable: true,
          },
          { when: { path: "result.ok", op: "equal", value: false }, to: "c" },
        ],
        otherwise: { to: "c", label: "Unclear" },
      },
    },
    b: {
      kind: "step",
      step: "b",
      next: {
        match: "all",
        overridable: true,
        routes: [
          { to: "c" },
          { when: { path: "result.x", op: "equal", value: 1 }, to: "c" },
        ],
      },
    },
    c: { kind: "succeed" },
  },
};

describe("translateDocumentToGraph — route labels and overrules", () => {
  const { edges } = translateDocumentToGraph(OVERRULE_PIPELINE);
  const routes = edges.filter((edge) => edge.data?.kind !== "start");

  test("shows a route's own label, keeping its condition for the tooltip", () => {
    expect(routes.map((edge) => [edge.label, edge.data?.condition])).toEqual([
      ["Looks good", "result.ok == true"],
      ["result.ok == false", undefined],
      ["Unclear", "otherwise"],
      ["always", undefined],
      ["result.x == 1", undefined],
    ]);
  });

  test("flags the routes a person may overrule", () => {
    expect(routes.map((edge) => edge.data?.overridable ?? false)).toEqual([
      true,
      false,
      false,
      false,
      true,
    ]);
  });
});
